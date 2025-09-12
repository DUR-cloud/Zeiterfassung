// src/App.jsx
import { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { supabase } from "./supabaseClient.js";

// ---------- Konstanten ----------
const LS_KEYS = {
  logo: "zeiterfassung_logo_v3",
  vacations: "zeiterfassung_vacations_v1",
  legacy_records: "zeiterfassung_records_v3",
};

const ADMIN_FALLBACK = "chef123";

// ---------- Helpers ----------
const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "");

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// 12–13 Uhr Pausenabzug (falls Intervall überlappt)
function subtractLunchIfNeeded(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (isNaN(start) || isNaN(end) || end <= start) return { minutes: 0, lunchApplied: false };

  const minutes = Math.round((end - start) / 60000);
  if (start.toDateString() !== end.toDateString()) return { minutes, lunchApplied: false };

  const lunchStart = new Date(start); lunchStart.setHours(12, 0, 0, 0);
  const lunchEnd   = new Date(start); lunchEnd.setHours(13, 0, 0, 0);
  const overlap = Math.max(0, Math.min(end.getTime(), lunchEnd.getTime()) - Math.max(start.getTime(), lunchStart.getTime()));
  const overlapMin = Math.round(overlap / 60000);
  if (overlapMin > 0) return { minutes: Math.max(0, minutes - overlapMin), lunchApplied: true };
  return { minutes, lunchApplied: false };
}

// ---------- App ----------
export default function App() {
  // Rollen
  const [role, setRole] = useState(null);

  // Stammdaten (Supabase)
  const [employees, setEmployees] = useState([]);
  const [projects, setProjects] = useState([]);

  // Records (Supabase)
  const [records, setRecords] = useState([]);

  // Urlaub (lokal) & Logo (lokal)
  const [vacations, setVacations] = useState([]);
  const [logoDataUrl, setLogoDataUrl] = useState(null);

  // Logins
  const [loginPw, setLoginPw] = useState("");
  const [loginName, setLoginName] = useState("");
  const [empPw, setEmpPw] = useState("");
  const [currentEmployee, setCurrentEmployee] = useState(null);

  // Auswahl/Erfassung
  const [selectedProject, setSelectedProject] = useState("");
  const [startTime, setStartTime] = useState(null);

  // Pause-Handling
  const [isPaused, setIsPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState(null);
  const [totalPausedMs, setTotalPausedMs] = useState(0);

  // Live-Anzeige (Laufzeit)
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!startTime) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startTime]);

  const runningMillis = useMemo(() => {
    if (!startTime) return 0;
    const now = Date.now();
    const base = now - new Date(startTime).getTime();
    const pausedExtra = isPaused && pausedAt ? now - new Date(pausedAt).getTime() : 0;
    return Math.max(0, base - totalPausedMs - pausedExtra);
  }, [startTime, isPaused, pausedAt, totalPausedMs, nowTick]);

  const runningHMS = useMemo(() => {
    let s = Math.floor(runningMillis / 1000);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [runningMillis]);

  // Admin-Form
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpPw, setNewEmpPw] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newProjectNote, setNewProjectNote] = useState("");

  // Inline-Editing Projekt-Notizen
  const [editNotes, setEditNotes] = useState({});

  // Urlaubseingabe
  const [vacStart, setVacStart] = useState("");
  const [vacEnd, setVacEnd] = useState("");

  // ---------- Edit-Dialog für Records ----------
  const [editId, setEditId] = useState(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editProjectId, setEditProjectId] = useState("");

  function toLocalInput(dtISO) {
    if (!dtISO) return "";
    const d = new Date(dtISO);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:mm'
  }
  function fromLocalInput(localStr) {
    if (!localStr) return null;
    const d = new Date(localStr);
    d.setMinutes(d.getMinutes() + d.getTimezoneOffset());
    return d.toISOString();
  }

  function openEdit(r) {
    // Mitarbeiter dürfen nur eigene Einträge editieren
    if (role === "employee" && currentEmployee && r.employeeId !== currentEmployee.id) {
      alert("Du kannst nur deine eigenen Zeiten bearbeiten.");
      return;
    }
    setEditId(r.id);
    setEditProjectId(r.projectId);
    setEditStart(toLocalInput(r.startISO));
    setEditEnd(toLocalInput(r.endISO));
  }

  function cancelEdit() {
    setEditId(null);
    setEditProjectId("");
    setEditStart("");
    setEditEnd("");
  }

  async function saveEdit() {
    if (!editId) return;
    const startISO = fromLocalInput(editStart);
    const endISO = fromLocalInput(editEnd);
    if (!startISO || !endISO) return alert("Bitte Start und Ende setzen.");
    if (new Date(endISO) <= new Date(startISO)) return alert("Ende muss nach Start liegen.");

    // Dauer neu berechnen (inkl. Mittag)
    const grossMin = Math.round((new Date(endISO) - new Date(startISO)) / 60000);
    const { minutes: lunchAdjusted } = subtractLunchIfNeeded(startISO, endISO);
    const duration = Math.max(0, lunchAdjusted);

    const { data, error } = await supabase
      .from("records")
      .update({
        project_id: editProjectId || null,
        start_iso: startISO,
        end_iso: endISO,
        duration_minutes: duration,
        lunch_applied: lunchAdjusted !== grossMin
      })
      .eq("id", editId)
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name, note )
      `)
      .single();

    if (error) return alert("Fehler beim Speichern: " + error.message);

    setRecords(prev => prev.map(r => r.id === editId ? {
      id: data.id,
      employeeId: data.employee_id,
      projectId: data.project_id,
      employee: data.employees?.name ?? "",
      project: data.projects?.name ?? "",
      date: new Date(data.start_iso).toLocaleDateString(),
      startISO: data.start_iso,
      endISO: data.end_iso,
      duration: data.duration_minutes,
      lunchApplied: data.lunch_applied,
    } : r));

    cancelEdit();
  }

  async function deleteRecord(id) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    if (role === "employee" && currentEmployee && rec.employeeId !== currentEmployee.id) {
      return alert("Du kannst nur deine eigenen Zeiten löschen.");
    }
    if (!confirm("Diesen Eintrag wirklich löschen?")) return;

    const { error } = await supabase.from("records").delete().eq("id", id);
    if (error) return alert("Fehler beim Löschen: " + error.message);
    setRecords(prev => prev.filter(r => r.id !== id));
    if (editId === id) cancelEdit();
  }

  // ---------- Supabase Laden ----------
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("employees").select("*").order("name");
      if (Array.isArray(data)) setEmployees(data);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("projects").select("*").order("name");
      if (Array.isArray(data)) setProjects(data);
    })();
  }, []);

  const loadRecords = async () => {
    const { data } = await supabase
      .from("records")
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name, note )
      `)
      .order("created_at", { ascending: false });
    if (Array.isArray(data)) {
      setRecords(
        data.map((r) => ({
          id: r.id,
          employeeId: r.employee_id,
          projectId: r.project_id,
          employee: r.employees?.name ?? "",
          project: r.projects?.name ?? "",
          date: new Date(r.start_iso).toLocaleDateString(),
          startISO: r.start_iso,
          endISO: r.end_iso,
          duration: r.duration_minutes,
          lunchApplied: r.lunch_applied,
        }))
      );
    }
  };
  useEffect(() => { loadRecords(); }, []);

  // Lokal: Urlaub + Logo
  useEffect(() => {
    const v = safeParse(localStorage.getItem(LS_KEYS.vacations), []);
    const l = localStorage.getItem(LS_KEYS.logo) || null;
    setVacations(Array.isArray(v) ? v : []);
    setLogoDataUrl(l);
  }, []);
  useEffect(() => { localStorage.setItem(LS_KEYS.vacations, JSON.stringify(vacations)); }, [vacations]);
  useEffect(() => { if (logoDataUrl) localStorage.setItem(LS_KEYS.logo, logoDataUrl); }, [logoDataUrl]);

  // (optional) Realtime + Polling (einfach: Polling)
  useEffect(() => {
    const poll = setInterval(loadRecords, 10000);
    return () => clearInterval(poll);
  }, []);

  // ---------- Logins ----------
  const handleLogin = () => {
    if (loginPw !== ADMIN_FALLBACK) return alert("Falsches Admin-Passwort");
    setRole("admin");
    setLoginPw("");
    setCurrentEmployee(null);
  };

  const handleEmployeeLogin = async () => {
    const emp = employees.find((e) => e.name === loginName && e.active !== false);
    if (!emp) return alert("Mitarbeiter nicht gefunden oder deaktiviert");
    const hash = await sha256Hex(empPw);
    if (emp.password_hash === hash) {
      setRole("employee");
      setCurrentEmployee(emp);
      setLoginName("");
      setEmpPw("");
    } else {
      alert("Falsches Passwort");
    }
  };

  const handleLogout = () => {
    setRole(null);
    setCurrentEmployee(null);
    setSelectedProject("");
    setStartTime(null);
    setIsPaused(false);
    setPausedAt(null);
    setTotalPausedMs(0);
    cancelEdit();
  };

  // ---------- Mitarbeiter ----------
  const addEmployee = async () => {
    if (!newEmpName.trim() || !newEmpPw.trim()) return alert("Bitte Name & Passwort eingeben");
    const password_hash = await sha256Hex(newEmpPw);
    const { data, error } = await supabase
      .from("employees")
      .insert({ name: newEmpName.trim(), password_hash, active: true })
      .select()
      .single();
    if (error) return alert("Fehler beim Speichern: " + error.message);
    setEmployees((prev) => [...prev, data]);
    setNewEmpName("");
    setNewEmpPw("");
  };

  const toggleEmployee = async (id) => {
    const emp = employees.find((e) => e.id === id);
    if (!emp) return;
    const { data, error } = await supabase
      .from("employees")
      .update({ active: !emp.active })
      .eq("id", id)
      .select()
      .single();
    if (error) return alert("Fehler: " + error.message);
    setEmployees((prev) => prev.map((e) => (e.id === id ? data : e)));
  };

  // ---------- Projekte ----------
  const addProject = async () => {
    if (!newProject.trim()) return;
    const { data, error } = await supabase
      .from("projects")
      .insert({ name: newProject.trim(), note: newProjectNote.trim() || "" })
      .select()
      .single();
    if (error) return alert("Fehler beim Speichern: " + error.message);
    setProjects((prev) => [...prev, data]);
    setNewProject("");
    setNewProjectNote("");
  };

  const saveProjectNote = async (projectId) => {
    const note = (editNotes[projectId] ?? "").trim();
    const { data, error } = await supabase
      .from("projects")
      .update({ note })
      .eq("id", projectId)
      .select()
      .single();
    if (error) return alert("Fehler beim Speichern der Notiz: " + error.message);
    setProjects((prev) => prev.map((p) => (p.id === projectId ? data : p)));
    setEditNotes((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  };

  const removeProject = async (id) => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) return alert("Fehler beim Löschen: " + error.message);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  // ---------- Erfassung ----------
  const handleStart = () => {
    if (!currentEmployee) return alert("Bitte als Mitarbeiter einloggen");
    if (!selectedProject) return alert("Bitte Projekt wählen");
    setStartTime(new Date());
    setIsPaused(false);
    setPausedAt(null);
    setTotalPausedMs(0);
  };

  const togglePause = () => {
    if (!startTime) return;
    if (!isPaused) {
      setIsPaused(true);
      setPausedAt(new Date());
    } else {
      // Pause beenden → aufsummieren
      if (pausedAt) {
        const extra = Date.now() - new Date(pausedAt).getTime();
        setTotalPausedMs((ms) => ms + Math.max(0, extra));
      }
      setPausedAt(null);
      setIsPaused(false);
    }
  };

  const handleStop = async () => {
    if (!startTime || !currentEmployee) return;

    // offene Pause beenden
    let pausedMs = totalPausedMs;
    if (isPaused && pausedAt) {
      pausedMs += Math.max(0, Date.now() - new Date(pausedAt).getTime());
    }

    const end = new Date();
    const startISO = new Date(startTime).toISOString();
    const endISO = end.toISOString();

    const grossMinutes = Math.round((new Date(endISO) - new Date(startISO)) / 60000);
    const pauseMinutes = Math.round(pausedMs / 60000);
    const { minutes: finalMinutes, lunchApplied } = subtractLunchIfNeeded(startISO, endISO);
    const durationMinutes = Math.max(0, finalMinutes - pauseMinutes);

    // IDs zu Name finden
    const proj = projects.find((p) => p.name === selectedProject);
    if (!proj) return alert("Projekt nicht gefunden");

    const { data, error } = await supabase
      .from("records")
      .insert({
        employee_id: currentEmployee.id,
        project_id: proj.id,
        start_iso: startISO,
        end_iso: endISO,
        duration_minutes: durationMinutes,
        lunch_applied: lunchApplied,
      })
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name, note )
      `)
      .single();

    if (error) return alert("Fehler beim Speichern: " + error.message);

    const mapped = {
      id: data.id,
      employeeId: data.employee_id,
      projectId: data.project_id,
      employee: data.employees?.name ?? "",
      project: data.projects?.name ?? "",
      date: new Date(data.start_iso).toLocaleDateString(),
      startISO: data.start_iso,
      endISO: data.end_iso,
      duration: data.duration_minutes,
      lunchApplied: data.lunch_applied,
    };
    setRecords((prev) => [mapped, ...prev]);

    // Reset
    setStartTime(null);
    setIsPaused(false);
    setPausedAt(null);
    setTotalPausedMs(0);
  };

  // ---------- Urlaub (lokal) ----------
  const handleVacationRequest = () => {
    if (!currentEmployee) return alert("Bitte einloggen");
    if (!vacStart || !vacEnd) return alert("Bitte Start- und Enddatum wählen");
    if (new Date(vacEnd) < new Date(vacStart)) return alert("Enddatum muss >= Startdatum sein");
    const newVac = {
      id: newId(),
      employeeId: currentEmployee.id,
      startDate: vacStart,
      endDate: vacEnd,
      status: "offen",
    };
    setVacations((prev) => [...prev, newVac]);
    setVacStart("");
    setVacEnd("");
  };
  const approveVacation = (id) =>
    setVacations((prev) => prev.map((v) => (v.id === id ? { ...v, status: "genehmigt" } : v)));
  const rejectVacation = (id) =>
    setVacations((prev) => prev.map((v) => (v.id === id ? { ...v, status: "abgelehnt" } : v)));

  // ---------- Anzeige-Hilfen ----------
  const myVacations = useMemo(
    () => (currentEmployee ? vacations.filter((v) => v.employeeId === currentEmployee.id) : []),
    [vacations, currentEmployee]
  );

  const selectedProjectObj = useMemo(
    () => projects.find((x) => x.name === selectedProject) || null,
    [projects, selectedProject]
  );

  // ---------- Render ----------
  return (
    <div style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      <h2>Digitale Zeiterfassung</h2>

      {/* ---------- Login ---------- */}
      {!role && (
        <section>
          <h3>Login</h3>
          <div style={{ display: "grid", gap: 8, maxWidth: 360 }}>
            <strong>Mitarbeiter</strong>
            <input placeholder="Name" value={loginName} onChange={(e) => setLoginName(e.target.value)} />
            <input type="password" placeholder="Passwort" value={empPw} onChange={(e) => setEmpPw(e.target.value)} />
            <button onClick={handleEmployeeLogin}>Mitarbeiter Login</button>

            <div style={{ margin: "8px 0", opacity: 0.6 }}>— oder —</div>

            <strong>Admin</strong>
            <input type="password" placeholder="Admin-Passwort" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} />
            <button onClick={handleLogin}>Admin Login</button>
          </div>
        </section>
      )}

      {/* ---------- Mitarbeiter-Ansicht ---------- */}
      {role === "employee" && currentEmployee && (
        <section style={{ marginTop: 16 }}>
          <h3>Zeiterfassung für {currentEmployee.name}</h3>
          <button onClick={handleLogout} style={{ marginBottom: 8 }}>Logout</button>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
              <option value="">Projekt wählen</option>
              {projects.map((p) => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
            <button onClick={handleStart} disabled={!selectedProject || !!startTime}>Start</button>
            <button onClick={togglePause} disabled={!startTime}>{isPaused ? "Weiter" : "Pause"}</button>
            <button onClick={handleStop} disabled={!startTime}>Stop</button>
            {startTime && (
              <span style={{ marginLeft: 8 }}>
                Laufzeit: <strong>{runningHMS}</strong>{isPaused ? " (pausiert)" : ""}
              </span>
            )}
          </div>

          {/* Projekt-Notiz anzeigen */}
          {selectedProjectObj && (
            <div style={{ marginTop: 8, padding: 8, background: "#f6f6f6", borderRadius: 6 }}>
              <strong>Projekt-Notiz:</strong>{" "}
              <span>{selectedProjectObj.note || "—"}</span>
            </div>
          )}

          <h4 style={{ marginTop: 16 }}>Zuletzt erfasste Zeiten</h4>
          {records.filter(r => r.employeeId === currentEmployee.id).length === 0 ? (
            <p>Noch keine Einträge</p>
          ) : (
            <ul>
              {records
                .filter(r => r.employeeId === currentEmployee.id)
                .map((r) => (
                  <li key={r.id}>
                    {r.date} | {r.project} | {fmtTime(r.startISO)}–{fmtTime(r.endISO)} | {r.duration} Min {r.lunchApplied ? "(Pause 12–13 abgezogen)" : ""}
                    {" "}
                    <button onClick={() => openEdit(r)}>Bearbeiten</button>
                    {" "}
                    <button onClick={() => deleteRecord(r.id)}>Löschen</button>
                  </li>
                ))}
            </ul>
          )}

          {/* Urlaub beantragen */}
          <h4 style={{ marginTop: 16 }}>Urlaub beantragen</h4>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input type="date" value={vacStart} onChange={(e) => setVacStart(e.target.value)} />
            <input type="date" value={vacEnd} onChange={(e) => setVacEnd(e.target.value)} />
            <button onClick={handleVacationRequest}>Beantragen</button>
          </div>
          <ul>
            {myVacations.length === 0 && <li>Keine Anträge</li>}
            {myVacations.map((v) => (
              <li key={v.id}>{v.startDate} – {v.endDate} → {v.status}</li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------- Admin-Ansicht ---------- */}
      {role === "admin" && (
        <section style={{ marginTop: 16 }}>
          <h3>Admin-Ansicht</h3>
          <button onClick={handleLogout}>Logout</button>

          {/* Mitarbeiter */}
          <h4 style={{ marginTop: 16 }}>Mitarbeiter</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input placeholder="Name" value={newEmpName} onChange={(e) => setNewEmpName(e.target.value)} />
            <input type="password" placeholder="Passwort" value={newEmpPw} onChange={(e) => setNewEmpPw(e.target.value)} />
            <button onClick={addEmployee}>Hinzufügen</button>
          </div>
          <ul>
            {employees.map((emp) => (
              <li key={emp.id} style={{ marginBottom: 6 }}>
                {emp.name} {emp.active ? "" : "(inaktiv)"}{" "}
                <button onClick={() => toggleEmployee(emp.id)}>{emp.active ? "Deaktivieren" : "Aktivieren"}</button>
              </li>
            ))}
          </ul>

          {/* Projekte inkl. Notizen */}
          <h4 style={{ marginTop: 16 }}>Projekte</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input
              placeholder="Neues Projekt"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
            />
            <input
              placeholder="Notiz (optional)"
              value={newProjectNote}
              onChange={(e) => setNewProjectNote(e.target.value)}
              style={{ minWidth: 260 }}
            />
            <button onClick={addProject}>Hinzufügen</button>
          </div>

          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
            {projects.map((p) => (
              <li key={p.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong>{p.name}</strong>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => removeProject(p.id)}>Löschen</button>
                  </div>
                </div>

                <div style={{ marginTop: 8 }}>
                  <label style={{ display: "block", fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
                    Projekt-Notiz
                  </label>
                  <textarea
                    rows={3}
                    style={{ width: "100%", resize: "vertical" }}
                    placeholder="Infos, Besonderheiten, Adresse, Ansprechpartner…"
                    value={editNotes[p.id] ?? p.note ?? ""}
                    onChange={(e) =>
                      setEditNotes((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                  />
                  <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                    <button onClick={() => saveProjectNote(p.id)}>Notiz speichern</button>
                    {editNotes[p.id] !== undefined && (
                      <button
                        onClick={() =>
                          setEditNotes((prev) => {
                            const next = { ...prev };
                            delete next[p.id];
                            return next;
                          })
                        }
                      >
                        Änderungen verwerfen
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {/* Zeiten */}
          <h4 style={{ marginTop: 16 }}>Zeiten</h4>
          {records.length === 0 ? <p>Keine Einträge</p> : (
            <ul>
              {records.map((r) => (
                <li key={r.id}>
                  {r.date} | {r.employee} | {r.project} | {fmtTime(r.startISO)}–{fmtTime(r.endISO)} | {r.duration} Min {r.lunchApplied ? "(Pause 12–13 abgezogen)" : ""}
                  {" "}
                  <button onClick={() => openEdit(r)}>Bearbeiten</button>
                  {" "}
                  <button onClick={() => deleteRecord(r.id)}>Löschen</button>
                </li>
              ))}
            </ul>
          )}

          {/* Exporte */}
          <h4 style={{ marginTop: 16 }}>Exporte</h4>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => {
                if (!records.length) return;
                const header = ["Mitarbeiter", "Projekt", "Datum", "Start", "Ende", "Minuten", "Lunch(12-13)"];
                const rows = records.map((r) => [
                  r.employee, r.project, r.date,
                  fmtTime(r.startISO), fmtTime(r.endISO),
                  String(r.duration ?? ""), r.lunchApplied ? "ja" : "nein",
                ]);
                const csv = [header, ...rows].map((row) => row.join(";")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = "zeiterfassung.csv"; a.click();
                URL.revokeObjectURL(url);
              }}
              disabled={!records.length}
            >
              CSV
            </button>
            <button
              onClick={async () => {
                if (!records.length) return;
                const XLSX = await import("xlsx");
                const data = records.map((r) => ({
                  Mitarbeiter: r.employee,
                  Projekt: r.project,
                  Datum: r.date,
                  Start: fmtTime(r.startISO),
                  Ende: fmtTime(r.endISO),
                  Minuten: r.duration ?? "",
                  "Lunch(12-13)": r.lunchApplied ? "ja" : "nein",
                }));
                const ws = XLSX.utils.json_to_sheet(data);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Zeiten");
                XLSX.writeFile(wb, "zeiterfassung.xlsx");
              }}
              disabled={!records.length}
            >
              Excel
            </button>
            <button
              onClick={() => {
                if (!records.length) return;
                const doc = new jsPDF();
                if (logoDataUrl) { try { doc.addImage(logoDataUrl, "PNG", 12, 10, 20, 20); } catch {} }
                doc.setFontSize(16); doc.text("Zeiterfassung Bericht", 40, 22);
                const head = [["Mitarbeiter", "Projekt", "Datum", "Start", "Ende", "Minuten", "Lunch(12-13)"]];
                const body = records.map((r) => [
                  r.employee, r.project, r.date,
                  fmtTime(r.startISO), fmtTime(r.endISO),
                  String(r.duration ?? ""), r.lunchApplied ? "ja" : "nein",
                ]);
                doc.autoTable({ head, body, startY: 36 }); doc.save("zeiterfassung.pdf");
              }}
              disabled={!records.length}
            >
              PDF
            </button>
          </div>
        </section>
      )}

      {/* ---------- Edit-Dialog (für Mitarbeiter-eigene oder Admin-alle) ---------- */}
      {editId && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <h4>Eintrag bearbeiten</h4>
          <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
            <label>
              Projekt
              <select
                value={editProjectId}
                onChange={(e) => setEditProjectId(e.target.value)}
              >
                <option value="">— wählen —</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>

            <label>
              Start
              <input
                type="datetime-local"
                value={editStart}
                onChange={(e) => setEditStart(e.target.value)}
              />
            </label>

            <label>
              Ende
              <input
                type="datetime-local"
                value={editEnd}
                onChange={(e) => setEditEnd(e.target.value)}
              />
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveEdit}>Speichern</button>
              <button onClick={cancelEdit}>Abbrechen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

