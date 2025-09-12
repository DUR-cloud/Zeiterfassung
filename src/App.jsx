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
  

  // Pause-Handling
 

  // ID des laufenden Datensatzes (für UPDATE beim Stop)
  const [runningRecordId, setRunningRecordId] = useState(localStorage.getItem("runningRecordId") || null);
  const [startISO, setStartISO] = useState(localStorage.getItem("startISO") || null);
  const [pausedMs, setPausedMs] = useState(Number(localStorage.getItem("pausedMs") || 0));
  const [pausedAtISO, setPausedAtISO] = useState(localStorage.getItem("pausedAtISO") || null);

  // Live-Anzeige (Laufzeit)
  const [nowTick, setNowTick] = useState(Date.now());
useEffect(() => {
  if (!startISO) return;
  const t = setInterval(() => setNowTick(Date.now()), 1000);
  return () => clearInterval(t);
}, [startISO]);

const runningMillis = useMemo(() => {
  if (!startISO) return 0;
  const now = Date.now();
  const base = now - new Date(startISO).getTime();
  const pausedExtra = pausedAtISO ? now - new Date(pausedAtISO).getTime() : 0;
  return Math.max(0, base - pausedMs - pausedExtra);
}, [startISO, pausedMs, pausedAtISO, nowTick]);

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

// ---------- Supabase Laden ----------
  // Employees
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("employees").select("*").order("name");
      if (!error && Array.isArray(data)) setEmployees(data);
    })();
  }, []);

  // Projects
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("projects").select("*").order("name");
      if (!error && Array.isArray(data)) setProjects(data);
    })();
  }, []);

  // Records
  const loadRecords = async () => {
    const { data, error } = await supabase
      .from("records")
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name, note )
      `)
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      const mapped = data.map((r) => ({
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
      }));
      setRecords(mapped);
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

  // Realtime + Polling (ein Effekt)
useEffect(() => {
  const reloadAll = async () => {
    try {
      const [empRes, projRes] = await Promise.all([
        supabase.from("employees").select("*").order("name"),
        supabase.from("projects").select("*").order("name"),
      ]);
      if (!empRes.error) setEmployees(empRes.data ?? []);
      if (!projRes.error) setProjects(projRes.data ?? []);
      await loadRecords();
    } catch {}
  };

  // sofort einmal laden
  reloadAll();

  // Realtime abonnieren
  const channel = supabase
    .channel("realtime-all")
    .on("postgres_changes", { event: "*", schema: "public", table: "records"  }, reloadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, reloadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "employees"}, reloadAll)
    .subscribe();

  // Fallback-Polling
  const poll = setInterval(reloadAll, 10000);

  return () => {
    supabase.removeChannel(channel);
    clearInterval(poll);
  };
}, []);

// 17:00-Autostopp (eigener Effekt)
useEffect(() => {
  if (!startISO || !runningRecordId) return;
  const iv = setInterval(() => {
    const start = new Date(startISO);
    const limit = new Date(start);
    limit.setHours(17, 0, 0, 0); // 17:00 am Start-Tag
    if (Date.now() >= +limit) {
      handleStop(); // beendet den laufenden Datensatz
    }
  }, 30_000); // alle 30s prüfen
  return () => clearInterval(iv);
}, [startISO, runningRecordId]);


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
  setRunningRecordId(null);
  setStartISO(null);
  setPausedMs(0);
  setPausedAtISO(null);
  localStorage.removeItem("runningRecordId");
  localStorage.removeItem("startISO");
  localStorage.removeItem("pausedMs");
  localStorage.removeItem("pausedAtISO");
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
  const handleStart = async () => {
  if (!currentEmployee) return alert("Bitte als Mitarbeiter einloggen");
  if (!selectedProject) return alert("Bitte Projekt wählen");

  // Projekt-ID zu Namen finden
  const proj = projects.find((p) => p.name === selectedProject);
  if (!proj) return alert("Projekt nicht gefunden");

  // Startzeit jetzt
  const nowISO = new Date().toISOString();

  // Beim Start wird EIN Datensatz angelegt: end_iso bleibt NULL, duration_minutes = 0
  const { data, error } = await supabase
    .from("records")
    .insert({
      employee_id: currentEmployee.id,
      project_id: proj.id,
      start_iso: nowISO,
      duration_minutes: 0,   // ← WICHTIG: niemals null
      lunch_applied: false
    })
    .select("id")
    .single();

  if (error) return alert("Fehler beim Start: " + error.message);

  // Laufzustand merken (auch im localStorage, falls Browser zugeht)
  setRunningRecordId(data.id);
  setStartISO(nowISO);
  setPausedMs(0);
  setPausedAtISO(null);
  localStorage.setItem("runningRecordId", data.id);
  localStorage.setItem("startISO", nowISO);
  localStorage.setItem("pausedMs", "0");
  localStorage.removeItem("pausedAtISO");
};

  const togglePause = () => {
  if (!runningRecordId || !startISO) return;

  if (!pausedAtISO) {
    // in Pause gehen
    const nowISO = new Date().toISOString();
    setPausedAtISO(nowISO);
    localStorage.setItem("pausedAtISO", nowISO);
  } else {
    // Pause beenden
    const extra = Date.now() - new Date(pausedAtISO).getTime();
    const next = Math.max(0, pausedMs + extra);
    setPausedMs(next);
    setPausedAtISO(null);
    localStorage.setItem("pausedMs", String(next));
    localStorage.removeItem("pausedAtISO");
  }
};


const handleStop = async () => {
  if (!runningRecordId || !startISO) return;

  // Offene Pause berücksichtigen
  let totalPaused = pausedMs;
  if (pausedAtISO) {
    totalPaused += Math.max(0, Date.now() - new Date(pausedAtISO).getTime());
  }

  const endISO = new Date().toISOString();

  // Brutto-Minuten
  const grossMin = Math.round((new Date(endISO) - new Date(startISO)) / 60000);
  const pausedMin = Math.round(totalPaused / 60000);

  // Automatische Mittagspause 12–13 zusätzlich abziehen (nur auf das Intervall selbst)
  const { minutes: lunchAdjusted } = subtractLunchIfNeeded(startISO, endISO);

  // finale Dauer = (brutto mit Mittag) - eigene Pausen
  const duration = Math.max(0, lunchAdjusted - pausedMin);

  const { error } = await supabase
    .from("records")
    .update({
      end_iso: endISO,
      duration_minutes: duration,
      lunch_applied: lunchAdjusted !== grossMin
    })
    .eq("id", runningRecordId);

  if (error) return alert("Fehler beim Stop: " + error.message);

  // Aufräumen
  setRunningRecordId(null);
  setStartISO(null);
  setPausedMs(0);
  setPausedAtISO(null);
  localStorage.removeItem("runningRecordId");
  localStorage.removeItem("startISO");
  localStorage.removeItem("pausedMs");
  localStorage.removeItem("pausedAtISO");

  // Liste neu laden
  await loadRecords();
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

// ---------- Export / Logo ----------
  const onLogoFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => setLogoDataUrl(e.target.result);
    reader.readAsDataURL(file);
  };

  // (optional) Migration lokale Zeiten → Supabase
  const migrateLocalRecordsToSupabase = async () => {
    const local = safeParse(localStorage.getItem(LS_KEYS.legacy_records), []);
    if (!Array.isArray(local) || local.length === 0) {
      alert("Keine lokalen Zeiten gefunden.");
      return;
    }
    if (!confirm(`Es werden ${local.length} lokale Einträge versucht zu migrieren. Fortfahren?`)) return;

    const empByName = new Map(employees.map((e) => [e.name, e.id]));
    const projByName = new Map(projects.map((p) => [p.name, p.id]));

    let ok = 0, fail = 0;
    for (const r of local) {
      try {
        const employee_id = empByName.get(r.employee);
        const project_id = projByName.get(r.project);
        if (!employee_id || !project_id || !r.startISO || !r.endISO) { fail++; continue; }
        const { minutes, lunchApplied } = subtractLunchIfNeeded(r.startISO, r.endISO);
        const { error } = await supabase.from("records").insert({
          employee_id, project_id,
          start_iso: r.startISO,
          end_iso: r.endISO,
          duration_minutes: minutes,
          lunch_applied: lunchApplied,
        });
        if (error) { fail++; continue; }
        ok++;
      } catch {
        fail++;
      }
    }
    await loadRecords();
    alert(`Migration abgeschlossen: ${ok} importiert, ${fail} übersprungen.`);
  };

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

<button onClick={handleStart} disabled={!selectedProject || !!startISO}>Start</button>
<button onClick={togglePause} disabled={!startISO}>{pausedAtISO ? "Weiter" : "Pause"}</button>
<button onClick={handleStop} disabled={!startISO}>Stop</button>

{startISO && (
  <span style={{ marginLeft: 8 }}>
    Laufzeit: <strong>{runningHMS}</strong>{pausedAtISO ? " (pausiert)" : ""}
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
          {records.length === 0 ? (
            <p>Noch keine Einträge</p>
          ) : (
            <ul>
              {records.map((r) => (
                <li key={r.id}>
                  {r.date} | {r.employee} | {r.project} | {fmtTime(r.startISO)}–{fmtTime(r.endISO)} | {r.duration} Min {r.lunchApplied ? "(Pause 12–13 abgezogen)" : ""}
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

          <div style={{ marginTop: 10 }}>
            <label>Logo für PDF: </label>
            <input type="file" accept="image/*" onChange={(e) => onLogoFile(e.target.files?.[0])} />
          </div>

          {/* Daten-Werkzeuge */}
          <h4 style={{ marginTop: 16 }}>Daten-Werkzeuge</h4>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={migrateLocalRecordsToSupabase}>Lokale Zeiten → Supabase (einmalig)</button>
          </div>
        </section>
      )}
    </div>
  );
}
