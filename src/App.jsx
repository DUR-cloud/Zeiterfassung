// src/App.jsx
import { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { supabase } from "./supabaseClient.js";

// ---------- Konstanten ----------
const LS_KEYS = {
  logo: "zeiterfassung_logo_v3",
  vacations: "zeiterfassung_vacations_v1",
  legacy_records: "zeiterfassung_records_v3", // alte lokale Zeiten (für Einmal-Migration)
};

const ADMIN_FALLBACK = "chef123"; // Admin-Passwort (einfach für Start)

// ---------- Hilfsfunktionen ----------
const newId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);
const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "");

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
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
  if (overlapMin > 0) return { minutes: Math.max(0, minutes - overlapMin), lunchApplied: true };
  return { minutes, lunchApplied: false };
}

// ---------- Hauptkomponente ----------
export default function App() {
  // Rollen: null (Login), "employee", "admin"
  const [role, setRole] = useState(null);

  // Stammdaten (Supabase)
  const [employees, setEmployees] = useState([]); // enthält auch note, password_hash, active
  const [projects, setProjects] = useState([]);

  // Zeiten/Records (aus Supabase geladen)
  const [records, setRecords] = useState([]);

  // Urlaub (lokal – kann später auch zentralisiert werden)
  const [vacations, setVacations] = useState([]);

  // Logo (lokal, nur fürs PDF)
  const [logoDataUrl, setLogoDataUrl] = useState(null);

  // Logins
  const [loginPw, setLoginPw] = useState(""); // Admin
  const [loginName, setLoginName] = useState(""); // Mitarbeiter
  const [empPw, setEmpPw] = useState(""); // Mitarbeiter
  const [currentEmployee, setCurrentEmployee] = useState(null);

  // Auswahl/Erfassung
  const [selectedProject, setSelectedProject] = useState("");
  const [startTime, setStartTime] = useState(null);

  // Admin-Form „Neuer Mitarbeiter/Projekt“
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpPw, setNewEmpPw] = useState("");
  const [newProject, setNewProject] = useState("");

  // Mitarbeiter-Notiz (lokaler UI-State gespiegelt zu Supabase)
  const [myNoteDraft, setMyNoteDraft] = useState("");

  // ---------- Supabase Laden: employees & projects ----------
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("employees").select("*").order("name");
      if (!error && Array.isArray(data)) setEmployees(data);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("projects").select("*").order("name");
      if (!error && Array.isArray(data)) setProjects(data);
    })();
  }, []);

  // ---------- Supabase Laden: records (Zeiten) ----------
  async function loadRecords() {
    const { data, error } = await supabase
      .from("records")
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name )
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
  }
  useEffect(() => { loadRecords(); }, []);

  // ---------- Lokal: Urlaub + Logo ----------
  useEffect(() => {
    const v = safeParse(localStorage.getItem(LS_KEYS.vacations), []);
    const l = localStorage.getItem(LS_KEYS.logo) || null;
    setVacations(Array.isArray(v) ? v : []);
    setLogoDataUrl(l);
  }, []);
  useEffect(() => { localStorage.setItem(LS_KEYS.vacations, JSON.stringify(vacations)); }, [vacations]);
  useEffect(() => { if (logoDataUrl) localStorage.setItem(LS_KEYS.logo, logoDataUrl); }, [logoDataUrl]);

  // ⬇️ Live-Updates via Supabase Realtime (+ Fallback Poll)
  useEffect(() => {
    const reloadAll = async () => {
      try {
        const [empRes, projRes, recRes] = await Promise.all([
          supabase.from("employees").select("*").order("name"),
          supabase.from("projects").select("*").order("name"),
          supabase
            .from("records")
            .select(`
              id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
              employees:employee_id ( name ),
              projects:project_id  ( name )
            `)
            .order("created_at", { ascending: false }),
        ]);

        if (!empRes.error) {
          setEmployees(empRes.data ?? []);
          // falls der aktuelle Mitarbeiter betroffen ist → Notiz-Entwurf aktualisieren
          if (currentEmployee) {
            const freshMe = (empRes.data ?? []).find(e => e.id === currentEmployee.id);
            if (freshMe) {
              setCurrentEmployee(freshMe);
              setMyNoteDraft(freshMe.note ?? "");
            }
          }
        }
        if (!projRes.error) setProjects(projRes.data ?? []);
        if (!recRes.error) {
          setRecords(
            (recRes.data ?? []).map(r => ({
              id: r.id,
              employeeId: r.employee_id,
              projectId: r.project_id,
              employee: r.employees?.name ?? "",
              project: r.projects?.name ?? "",
              date: new Date(r.start_iso).toLocaleDateString(),
              startISO: r.start_iso,
              endISO: r.end_iso,
              duration: r.duration_minutes,
              lunchApplied: r.lunch_applied
            }))
          );
        }
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
  }, [currentEmployee]);

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
      setMyNoteDraft(emp.note ?? "");
    } else {
      alert("Falsches Passwort");
    }
  };

  const handleLogout = () => {
    setRole(null);
    setCurrentEmployee(null);
    setSelectedProject("");
    setStartTime(null);
    setMyNoteDraft("");
  };

  // ---------- Mitarbeiter (Supabase) ----------
  const addEmployee = async () => {
    if (!newEmpName.trim() || !newEmpPw.trim()) return alert("Bitte Name & Passwort eingeben");
    const passwordHash = await sha256Hex(newEmpPw);
    const { data, error } = await supabase
      .from("employees")
      .insert({ name: newEmpName.trim(), password_hash: passwordHash, active: true, note: "" })
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
    if (currentEmployee?.id === id) setCurrentEmployee(data);
  };

  // ---------- Projekte (Supabase) ----------
  const addProject = async () => {
    if (!newProject.trim()) return;
    const { data, error } = await supabase
      .from("projects")
      .insert({ name: newProject.trim() })
      .select()
      .single();
    if (error) return alert("Fehler beim Speichern: " + error.message);
    setProjects((prev) => [...prev, data]);
    setNewProject("");
  };

  const removeProject = async (id) => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) return alert("Fehler beim Löschen: " + error.message);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  // ---------- Erfassung (Supabase) ----------
  const handleStart = () => {
    if (!currentEmployee) return alert("Bitte als Mitarbeiter einloggen");
    if (!selectedProject) return alert("Bitte Projekt wählen");
    setStartTime(new Date());
  };

  const handleStop = async () => {
    if (!startTime || !currentEmployee) return;
    const end = new Date();
    const { minutes, lunchApplied } = subtractLunchIfNeeded(startTime.toISOString(), end.toISOString());

    // IDs zu Name finden
    const proj = projects.find((p) => p.name === selectedProject);
    if (!proj) return alert("Projekt nicht gefunden");

    const { data, error } = await supabase
      .from("records")
      .insert({
        employee_id: currentEmployee.id,
        project_id: proj.id,
        start_iso: startTime.toISOString(),
        end_iso: end.toISOString(),
        duration_minutes: minutes,
        lunch_applied: lunchApplied,
      })
      .select(`
        id, employee_id, project_id, start_iso, end_iso, duration_minutes, lunch_applied, created_at,
        employees:employee_id ( name ),
        projects:project_id  ( name )
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
    setStartTime(null);
  };

  // ---------- Urlaub (lokal) ----------
  const [vacStart, setVacStart] = useState("");
  const [vacEnd, setVacEnd] = useState("");

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

  // ---------- Backup/Restore (nur lokale Daten + Logo) ----------
  const onLogoFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => setLogoDataUrl(e.target.result);
    reader.readAsDataURL(file);
  };

  // Einmal-Migration: lokale alte Zeiten → Supabase
  const migrateLocalRecordsToSupabase = async () => {
    const local = safeParse(localStorage.getItem(LS_KEYS.legacy_records), []);
    if (!Array.isArray(local) || local.length === 0) {
      alert("Keine lokalen Zeiten gefunden.");
      return;
    }
    if (!confirm(`Es werden ${local.length} lokale Einträge migriert. Fortfahren?`)) return;

    // Map Namen → IDs
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

  // Anzeige-Hilfen
  const myVacations = useMemo(
    () => (currentEmployee ? vacations.filter((v) => v.employeeId === currentEmployee.id) : []),
    [vacations, currentEmployee]
  );

  // ---------- Notiz speichern (Mitarbeiter) ----------
  const saveMyNote = async () => {
    if (!currentEmployee) return;
    const { data, error } = await supabase
      .from("employees")
      .update({ note: myNoteDraft })
      .eq("id", currentEmployee.id)
      .select()
      .single();
    if (error) {
      alert("Fehler beim Speichern der Notiz: " + error.message);
      return;
    }
    // State aktualisieren (Liste + aktueller Mitarbeiter)
    setEmployees(prev => prev.map(e => e.id === data.id ? data : e));
    setCurrentEmployee(data);
    setMyNoteDraft(data.note ?? "");
  };

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
            <button onClick={handleStop} disabled={!startTime}>Stop</button>
            {startTime && <span>Gestartet: {fmtTime(startTime.toISOString())}</span>}
          </div>

          <h4 style={{ marginTop: 16 }}>Zuletzt erfasste Zeiten</h4>
          {records.length === 0 ? (
            <p>Noch keine Einträge</p>
          ) : (
            <ul>
              {records.map((r) => (
                <li key={r.id}>
                  {r.date} | {r.employee} | {r.project} | {fmtTime(r.startISO)}–{fmtTime(r.endISO)} | {r.duration} Min {r.lunchApplied ? "(Pause abgezogen)" : ""}
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

          {/* Notizfeld */}
          <h4 style={{ marginTop: 16 }}>Meine Notiz</h4>
          <textarea
            value={myNoteDraft}
            onChange={(e) => setMyNoteDraft(e.target.value)}
            rows={3}
            style={{ width: "100%" }}
            placeholder="Schreibe hier deine Notiz (z. B. Außendienst, krank, Einsatzort …)"
          />
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button onClick={saveMyNote}>Notiz speichern</button>
            <span style={{ opacity: 0.7 }}>
              Sichtbar für Admin in der Mitarbeiterliste
            </span>
          </div>
        </section>
      )}

      {/* ---------- Admin-Ansicht ---------- */}
      {role === "admin" && (
        <section style={{ marginTop: 16 }}>
          <h3>Admin-Ansicht</h3>
          <button onClick={handleLogout}>Logout</button>

          <h4 style={{ marginTop: 16 }}>Mitarbeiter</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input placeholder="Name" value={newEmpName} onChange={(e) => setNewEmpName(e.target.value)} />
            <input type="password" placeholder="Passwort" value={newEmpPw} onChange={(e) => setNewEmpPw(e.target.value)} />
            <button onClick={addEmployee}>Hinzufügen</button>
          </div>
          <ul>
            {employees.map((emp) => (
              <li key={emp.id} style={{ marginBottom: 8 }}>
                <div>
                  <strong>{emp.name}</strong> {emp.active ? "" : "(inaktiv)"}
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    <em>Notiz:</em> {emp.note?.trim() ? emp.note : "—"}
                  </div>
                </div>
                <div style={{ marginTop: 4 }}>
                  <button onClick={() => toggleEmployee(emp.id)}>
                    {emp.active ? "Deaktivieren" : "Aktivieren"}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <h4 style={{ marginTop: 16 }}>Projekte</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input placeholder="Neues Projekt" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
            <button onClick={addProject}>Hinzufügen</button>
          </div>
          <ul>
            {projects.map((p) => (
              <li key={p.id}>
                {p.name} <button onClick={() => removeProject(p.id)}>Löschen</button>
              </li>
            ))}
          </ul>

          <h4 style={{ marginTop: 16 }}>Zeiten</h4>
          {records.length === 0 ? <p>Keine Einträge</p> : (
            <ul>
              {records.map((r) => (
                <li key={r.id}>
                  {r.date} | {r.employee} | {r.project} | {fmtTime(r.startISO)}–{fmtTime(r.endISO)} | {r.duration} Min {r.lunchApplied ? "(Pause abgezogen)" : ""}
                </li>
              ))}
            </ul>
          )}

          <h4 style={{ marginTop: 16 }}>Exporte</h4>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={async () => {
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

          <h4 style={{ marginTop: 16 }}>Daten-Werkzeuge</h4>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={migrateLocalRecordsToSupabase}>Lokale Zeiten → Supabase (einmalig)</button>
          </div>

          <h4 style={{ marginTop: 16 }}>Urlaubsanträge</h4>
          <ul>
            {vacations.length === 0 && <li>Keine Anträge</li>}
            {vacations.map((v) => {
              const emp = employees.find((e) => e.id === v.employeeId);
              return (
                <li key={v.id}>
                  {emp ? emp.name : "?"}: {v.startDate} – {v.endDate} → {v.status}{" "}
                  {v.status === "offen" && (
                    <>
                      <button onClick={() => approveVacation(v.id)}>Genehmigen</button>{" "}
                      <button onClick={() => rejectVacation(v.id)}>Ablehnen</button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
