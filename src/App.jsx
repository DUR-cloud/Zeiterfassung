// src/App.jsx
import { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { supabase } from "./supabaseClient.js";

// ----------------- Konstanten -----------------
const LS_KEYS = {
  logo: "zeiterfassung_logo_v3",
  vacations: "zeiterfassung_vacations_v1",
  legacy_records: "zeiterfassung_records_v3",
};
const ADMIN_FALLBACK = "chef123"; // Demo-Admin-PW
const RUN_KEY = (empId) => `running_record_${empId}`;

// ----------------- Helfer -----------------
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
  try { const v = JSON.parse(json); return v ?? fallback; } catch { return fallback; }
}

// 12–13 Uhr Pause automatisch abziehen, wenn Intervall überlappt
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
  return overlapMin > 0
    ? { minutes: Math.max(0, minutes - overlapMin), lunchApplied: true }
    : { minutes, lunchApplied: false };
}

// ----------------- App -----------------
export default function App() {
  // Rolle & Benutzer
  const [role, setRole] = useState(null); // null | 'employee' | 'admin'
  const [currentEmployee, setCurrentEmployee] = useState(null);

  // Stammdaten
  const [employees, setEmployees] = useState([]);
  const [projects, setProjects] = useState([]);

  // Zeiten
  const [records, setRecords] = useState([]);

  // Laufende Buchung
  const [runningRecord, setRunningRecord] = useState(null); // {id, startISO, projectId, projectName}
  const [startTime, setStartTime] = useState(null);         // Date-Objekt für Live-Timer
  const [, forceTick] = useState(0); // re-render für Live-Uhr

  // UI / Form
  const [selectedProject, setSelectedProject] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [loginName, setLoginName] = useState("");
  const [empPw, setEmpPw] = useState("");
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpPw, setNewEmpPw] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newProjectNote, setNewProjectNote] = useState("");
  const [editNotes, setEditNotes] = useState({}); // { [projectId]: "text" }

  // Urlaub (lokal wie gehabt)
  const [vacations, setVacations] = useState([]);
  const [vacStart, setVacStart] = useState("");
  const [vacEnd, setVacEnd] = useState("");

  // Logo (lokal)
  const [logoDataUrl, setLogoDataUrl] = useState(null);

  // ---------- Initiales Laden ----------
  useEffect(() => {
    (async () => {
      const [eRes, pRes] = await Promise.all([
        supabase.from("employees").select("*").order("name"),
        supabase.from("projects").select("*").order("name"),
      ]);
      if (!eRes.error) setEmployees(eRes.data ?? []);
      if (!pRes.error) setProjects(pRes.data ?? []);
    })();
  }, []);

  async function loadRecords() {
    const { data, error } = await supabase
      .from("records")
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, status, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name, note )
      `)
      .order("created_at", { ascending: false });

    if (error) return;
    const mapped = (data ?? []).map((r) => ({
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
      status: r.status,
    }));
    setRecords(mapped);
  }
  useEffect(() => { loadRecords(); }, []);

  // Urlaub & Logo lokal laden/speichern
  useEffect(() => {
    const v = safeParse(localStorage.getItem(LS_KEYS.vacations), []);
    const l = localStorage.getItem(LS_KEYS.logo) || null;
    setVacations(Array.isArray(v) ? v : []);
    setLogoDataUrl(l);
  }, []);
  useEffect(() => { localStorage.setItem(LS_KEYS.vacations, JSON.stringify(vacations)); }, [vacations]);
  useEffect(() => { if (logoDataUrl) localStorage.setItem(LS_KEYS.logo, logoDataUrl); }, [logoDataUrl]);

  // Realtime & Polling
  useEffect(() => {
    const reloadAll = async () => {
      try {
        const [eRes, pRes] = await Promise.all([
          supabase.from("employees").select("*").order("name"),
          supabase.from("projects").select("*").order("name"),
        ]);
        if (!eRes.error) setEmployees(eRes.data ?? []);
        if (!pRes.error) setProjects(pRes.data ?? []);
        await loadRecords();
      } catch {}
    };

    const channel = supabase
      .channel("realtime-all")
      .on("postgres_changes", { event: "*", schema: "public", table: "employees" }, reloadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects"  }, reloadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "records"   }, reloadAll)
      .subscribe();

    const poll = setInterval(reloadAll, 10000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(poll);
    };
  }, []);

  // Live-Uhr (jede Sekunde)
  useEffect(() => {
    if (!startTime) return;
    const t = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [startTime]);

  // Nach Login: evtl. laufenden Record aus LocalStorage in UI setzen
  useEffect(() => {
    if (!currentEmployee) return;
    const raw = localStorage.getItem(RUN_KEY(currentEmployee.id));
    if (!raw) return;
    try {
      const rr = JSON.parse(raw);
      setRunningRecord(rr);
      setStartTime(new Date(rr.startISO));
      setSelectedProject(rr.projectName || "");
    } catch {}
  }, [currentEmployee]);

  // ---------- Login ----------
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
    if (emp.password_hash !== hash) return alert("Falsches Passwort");

    setRole("employee");
    setCurrentEmployee(emp);
    setLoginName("");
    setEmpPw("");

    // offenen Record nach Login laden
    const { data: openRec, error: openErr } = await supabase
      .from("records")
      .select(`
        id, employee_id, project_id, start_iso, status,
        projects:project_id ( name )
      `)
      .eq("employee_id", emp.id)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!openErr && openRec) {
      // ggf. Auto-Stop bis 17:00
      const start = new Date(openRec.start_iso);
      const seventeen = new Date(start);
      seventeen.setHours(17, 0, 0, 0);

      if (Date.now() > seventeen.getTime() && start.toDateString() === new Date().toDateString()) {
        const { minutes, lunchApplied } = subtractLunchIfNeeded(start.toISOString(), seventeen.toISOString());
        await supabase
          .from("records")
          .update({
            end_iso: seventeen.toISOString(),
            duration_minutes: minutes,
            lunch_applied: lunchApplied,
            status: "auto-stopped",
          })
          .eq("id", openRec.id);

        localStorage.removeItem(RUN_KEY(emp.id));
        setRunningRecord(null);
        setStartTime(null);
        await loadRecords();
        alert("Laufende Zeit wurde automatisch um 17:00 gestoppt.");
      } else {
        const rr = {
          id: openRec.id,
          startISO: openRec.start_iso,
          projectId: openRec.project_id,
          projectName: openRec.projects?.name ?? "",
        };
        setRunningRecord(rr);
        setStartTime(new Date(openRec.start_iso));
        setSelectedProject(rr.projectName || "");
        localStorage.setItem(RUN_KEY(emp.id), JSON.stringify(rr));
      }
    } else {
      setRunningRecord(null);
      localStorage.removeItem(RUN_KEY(emp.id));
    }
  };

  const handleLogout = () => {
    setRole(null);
    setCurrentEmployee(null);
    setSelectedProject("");
    setStartTime(null);
    setRunningRecord(null);
  };

  // ---------- Mitarbeiter-CRUD ----------
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

  // ---------- Projekte (mit Notizen) ----------
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
      const next = { ...prev }; delete next[projectId]; return next;
    });
  };

  const removeProject = async (id) => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) return alert("Fehler beim Löschen: " + error.message);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  // ---------- Start/Stop ----------
  const handleStart = async () => {
    if (!currentEmployee) return alert("Bitte als Mitarbeiter einloggen");
    if (!selectedProject) return alert("Bitte Projekt wählen");
    if (runningRecord) return alert("Es läuft bereits eine Buchung.");

    const proj = projects.find((p) => p.name === selectedProject);
    if (!proj) return alert("Projekt nicht gefunden");

    const nowISO = new Date().toISOString();
    const { data, error } = await supabase
      .from("records")
      .insert({
        employee_id: currentEmployee.id,
        project_id: proj.id,
        start_iso: nowISO,
        end_iso: null,
        duration_minutes: null,
        lunch_applied: false,
        status: "running",
      })
      .select(`
        id, employee_id, project_id, start_iso,
        projects:project_id ( name )
      `)
      .single();

    if (error) return alert("Fehler beim Start: " + error.message);

    setStartTime(new Date(nowISO));
    const rr = {
      id: data.id,
      startISO: data.start_iso,
      projectId: data.project_id,
      projectName: data.projects?.name ?? selectedProject,
    };
    setRunningRecord(rr);
    localStorage.setItem(RUN_KEY(currentEmployee.id), JSON.stringify(rr));
  };

  const handleStop = async () => {
    if (!currentEmployee) return;
    if (!runningRecord || !startTime) return;

    const end = new Date();
    const { minutes, lunchApplied } = subtractLunchIfNeeded(startTime.toISOString(), end.toISOString());

    const { data, error } = await supabase
      .from("records")
      .update({
        end_iso: end.toISOString(),
        duration_minutes: minutes,
        lunch_applied: lunchApplied,
        status: "stopped",
      })
      .eq("id", runningRecord.id)
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name, note )
      `)
      .single();

    if (error) return alert("Fehler beim Stop: " + error.message);

    const mapped = {
      id: data.id,
      employeeId: data.employee_id,
      projectId: data.project_id,
      employee: data.employees?.name ?? currentEmployee.name,
      project: data.projects?.name ?? runningRecord.projectName,
      date: new Date(data.start_iso).toLocaleDateString(),
      startISO: data.start_iso,
      endISO: data.end_iso,
      duration: data.duration_minutes,
      lunchApplied: data.lunch_applied,
    };
    setRecords((prev) => [mapped, ...prev]);
    setStartTime(null);
    setRunningRecord(null);
    localStorage.removeItem(RUN_KEY(currentEmployee.id));
  };

  // ---------- Urlaub lokal ----------
  const handleVacationRequest = () => {
    if (!currentEmployee) return alert("Bitte einloggen");
    if (!vacStart || !vacEnd) return alert("Bitte Start- und Enddatum wählen");
    if (new Date(vacEnd) < new Date(vacStart)) return alert("Enddatum muss >= Startdatum sein");
    const newVac = { id: newId(), employeeId: currentEmployee.id, startDate: vacStart, endDate: vacEnd, status: "offen" };
    setVacations((prev) => [...prev, newVac]);
    setVacStart(""); setVacEnd("");
  };
  const approveVacation = (id) => setVacations((prev) => prev.map((v) => (v.id === id ? { ...v, status: "genehmigt" } : v)));
  const rejectVacation  = (id) => setVacations((prev) => prev.map((v) => (v.id === id ? { ...v, status: "abgelehnt" } : v)));

  // ---------- Export/Logo ----------
  const onLogoFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => setLogoDataUrl(e.target.result);
    reader.readAsDataURL(file);
  };

  // ---------- Migration lokal -> Supabase (optional) ----------
  const migrateLocalRecordsToSupabase = async () => {
    const local = safeParse(localStorage.getItem(LS_KEYS.legacy_records), []);
    if (!Array.isArray(local) || local.length === 0) { alert("Keine lokalen Zeiten gefunden."); return; }
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
          status: "stopped",
        });
        if (error) { fail++; continue; }
        ok++;
      } catch { fail++; }
    }
    await loadRecords();
    alert(`Migration abgeschlossen: ${ok} importiert, ${fail} übersprungen.`);
  };

  // ---------- Anzeige / Ableitungen ----------
  const selectedProjectObj = useMemo(
    () => projects.find((x) => x.name === selectedProject) || null,
    [projects, selectedProject]
  );

  const myRecords = useMemo(() => {
    if (!currentEmployee) return [];
    return records.filter((r) => r.employee === currentEmployee.name);
  }, [records, currentEmployee]);

  // ----------------- UI -----------------
  return (
    <div style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      <h2>Digitale Zeiterfassung</h2>

      {/* Login */}
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

      {/* Mitarbeiter-Ansicht */}
      {role === "employee" && currentEmployee && (
        <section style={{ marginTop: 16 }}>
          <h3>Zeiterfassung für {currentEmployee.name}</h3>
          <button onClick={handleLogout} style={{ marginBottom: 8 }}>Logout</button>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
              <option value="">Projekt wählen</option>
              {projects.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
            <button onClick={handleStart} disabled={!selectedProject || !!runningRecord}>Start</button>
            <button onClick={handleStop} disabled={!runningRecord}>Stop</button>
            {startTime && (
              <span>
                Gestartet: {fmtTime(startTime.toISOString())} •
                Gelaufen: {Math.floor((Date.now() - startTime.getTime()) / 60000)} min
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

          <h4 style={{ marginTop: 16 }}>Meine letzten Zeiten</h4>
          {myRecords.length === 0 ? (
            <p>Noch keine Einträge</p>
          ) : (
            <ul>
              {myRecords.map((r) => (
                <li key={r.id}>
                  {r.date} | {r.project} | {fmtTime(r.startISO)}–{r.endISO ? fmtTime(r.endISO) : "läuft …"} |{" "}
                  {r.duration ?? "—"} Min {r.lunchApplied ? "(Pause abgezogen)" : ""} {r.status ? `• ${r.status}` : ""}
                </li>
              ))}
            </ul>
          )}

          {/* Urlaub */}
          <h4 style={{ marginTop: 16 }}>Urlaub beantragen</h4>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input type="date" value={vacStart} onChange={(e) => setVacStart(e.target.value)} />
            <input type="date" value={vacEnd} onChange={(e) => setVacEnd(e.target.value)} />
            <button onClick={handleVacationRequest}>Beantragen</button>
          </div>
          <ul>
            {vacations.filter(v => v.employeeId === currentEmployee.id).map((v) => (
              <li key={v.id}>{v.startDate} – {v.endDate} → {v.status}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Admin-Ansicht */}
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

          {/* Projekte + Notizen */}
          <h4 style={{ marginTop: 16 }}>Projekte</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input placeholder="Neues Projekt" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
            <input placeholder="Notiz (optional)" value={newProjectNote} onChange={(e) => setNewProjectNote(e.target.value)} style={{ minWidth: 260 }} />
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
                  <label style={{ display: "block", fontSize: 12, opacity: 0.7, marginBottom: 4 }}>Projekt-Notiz</label>
                  <textarea
                    rows={3}
                    style={{ width: "100%", resize: "vertical" }}
                    placeholder="Infos, Besonderheiten, Adresse, Ansprechpartner…"
                    value={editNotes[p.id] ?? p.note ?? ""}
                    onChange={(e) => setEditNotes((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                  <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                    <button onClick={() => saveProjectNote(p.id)}>Notiz speichern</button>
                    {editNotes[p.id] !== undefined && (
                      <button onClick={() => setEditNotes((prev) => { const n = { ...prev }; delete n[p.id]; return n; })}>
                        Änderungen verwerfen
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {/* Zeiten (alle) */}
          <h4 style={{ marginTop: 16 }}>Zeiten</h4>
          {records.length === 0 ? <p>Keine Einträge</p> : (
            <ul>
              {records.map((r) => (
                <li key={r.id}>
                  {r.date} | {r.employee} | {r.project} | {fmtTime(r.startISO)}–{r.endISO ? fmtTime(r.endISO) : "läuft …"} |{" "}
                  {r.duration ?? "—"} Min {r.lunchApplied ? "(Pause abgezogen)" : ""} {r.status ? `• ${r.status}` : ""}
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
                const header = ["Mitarbeiter", "Projekt", "Datum", "Start", "Ende", "Minuten", "Lunch(12-13)", "Status"];
                const rows = records.map((r) => [
                  r.employee, r.project, r.date, fmtTime(r.startISO),
                  r.endISO ? fmtTime(r.endISO) : "läuft …",
                  String(r.duration ?? ""), r.lunchApplied ? "ja" : "nein",
                  r.status || "",
                ]);
                const csv = [header, ...rows].map((row) => row.join(";")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a"); a.href = url; a.download = "zeiterfassung.csv"; a.click();
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
                  Ende: r.endISO ? fmtTime(r.endISO) : "läuft …",
                  Minuten: r.duration ?? "",
                  "Lunch(12-13)": r.lunchApplied ? "ja" : "nein",
                  Status: r.status || "",
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
                const head = [["Mitarbeiter", "Projekt", "Datum", "Start", "Ende", "Minuten", "Lunch(12-13)", "Status"]];
                const body = records.map((r) => [
                  r.employee, r.project, r.date, fmtTime(r.startISO),
                  r.endISO ? fmtTime(r.endISO) : "läuft …",
                  String(r.duration ?? ""), r.lunchApplied ? "ja" : "nein",
                  r.status || "",
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

          {/* Tools */}
          <h4 style={{ marginTop: 16 }}>Daten-Werkzeuge</h4>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={migrateLocalRecordsToSupabase}>Lokale Zeiten → Supabase (einmalig)</button>
          </div>
        </section>
      )}
    </div>
  );
}
