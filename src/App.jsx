import { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { supabase } from "./supabaseClient";

// ---------- Konstanten ----------
const LS_KEYS = {
  records: "zeiterfassung_records_v3",
  logo: "zeiterfassung_logo_v3",
  vacations: "zeiterfassung_vacations_v1",
};

const ADMIN_FALLBACK = "chef123"; // Admin-Passwort (einfach)

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
  const [employees, setEmployees] = useState([]);
  const [projects, setProjects] = useState([]);

  // Datenerfassung (lokal)
  const [records, setRecords] = useState([]);
  const [logoDataUrl, setLogoDataUrl] = useState(null);

  // Urlaub (lokal)
  const [vacations, setVacations] = useState([]);

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

  // Mitarbeiter: Urlaub beantragen
  const [vacStart, setVacStart] = useState("");
  const [vacEnd, setVacEnd] = useState("");

  // ---------- Supabase Laden: employees & projects ----------
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("employees")
        .select("*")
        .order("name");
      if (!error && Array.isArray(data)) setEmployees(data);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .order("name");
      if (!error && Array.isArray(data)) setProjects(data);
    })();
  }, []);

  // ---------- Lokal Laden: records, vacations, logo ----------
  useEffect(() => {
    const r = safeParse(localStorage.getItem(LS_KEYS.records), []);
    const v = safeParse(localStorage.getItem(LS_KEYS.vacations), []);
    const l = localStorage.getItem(LS_KEYS.logo) || null;
    setRecords(Array.isArray(r) ? r : []);
    setVacations(Array.isArray(v) ? v : []);
    setLogoDataUrl(l);
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.records, JSON.stringify(records));
  }, [records]);
  useEffect(() => {
    localStorage.setItem(LS_KEYS.vacations, JSON.stringify(vacations));
  }, [vacations]);
  useEffect(() => {
    if (logoDataUrl) localStorage.setItem(LS_KEYS.logo, logoDataUrl);
  }, [logoDataUrl]);

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
    if (emp.passwordHash === hash) {
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
  };

  // ---------- Mitarbeiter (Supabase) ----------
  const addEmployee = async () => {
    if (!newEmpName.trim() || !newEmpPw.trim()) return alert("Bitte Name & Passwort eingeben");
    const passwordHash = await sha256Hex(newEmpPw);

    const { data, error } = await supabase
      .from("employees")
      .insert({ name: newEmpName.trim(), passwordHash, active: true })
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

  // ---------- Erfassung (lokal) ----------
  const handleStart = () => {
    if (!currentEmployee) return alert("Bitte als Mitarbeiter einloggen");
    if (!selectedProject) return alert("Bitte Projekt wählen");
    setStartTime(new Date());
  };

  const handleStop = () => {
    if (!startTime || !currentEmployee) return;
    const end = new Date();
    const { minutes, lunchApplied } = subtractLunchIfNeeded(
      startTime.toISOString(),
      end.toISOString()
    );
    const rec = {
      employee: currentEmployee.name,
      project: selectedProject,
      date: fmtDate(startTime),
      startISO: startTime.toISOString(),
      endISO: end.toISOString(),
      duration: minutes,
      lunchApplied,
    };
    setRecords((prev) => [...prev, rec]);
    setStartTime(null);
  };

  // ---------- Urlaub (lokal) ----------
  const handleVacationRequest = () => {
    if (!currentEmployee) return alert("Bitte einloggen");
    if (!vacStart || !vacEnd) return alert("Bitte Start- und Enddatum wählen");
    if (new Date(vacEnd) < new Date(vacStart))
      return alert("Enddatum muss >= Startdatum sein");

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
    setVacations((prev) =>
      prev.map((v) => (v.id === id ? { ...v, status: "genehmigt" } : v))
    );
  const rejectVacation = (id) =>
    setVacations((prev) =>
      prev.map((v) => (v.id === id ? { ...v, status: "abgelehnt" } : v))
    );

  // ---------- Exporte ----------
  const exportCSV = () => {
    if (!records.length) return;
    const header = ["Mitarbeiter", "Projekt", "Datum", "Start", "Ende", "Minuten", "Lunch(12-13)"];
    const rows = records.map((r) => [
      r.employee,
      r.project,
      r.date,
      fmtTime(r.startISO),
      fmtTime(r.endISO),
      String(r.duration ?? ""),
      r.lunchApplied ? "ja" : "nein",
    ]);
    const csv = [header, ...rows].map((row) => row.join(";")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "zeiterfassung.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = async () => {
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
  };

  const exportPDF = () => {
    if (!records.length) return;
    const doc = new jsPDF();
    if (logoDataUrl) {
      try {
        doc.addImage(logoDataUrl, "PNG", 12, 10, 20, 20);
      } catch {}
    }
    doc.setFontSize(16);
    doc.text("Zeiterfassung Bericht", 40, 22);

    const head = [["Mitarbeiter", "Projekt", "Datum", "Start", "Ende", "Minuten", "Lunch(12-13)"]];
    const body = records.map((r) => [
      r.employee,
      r.project,
      r.date,
      fmtTime(r.startISO),
      fmtTime(r.endISO),
      String(r.duration ?? ""),
      r.lunchApplied ? "ja" : "nein",
    ]);
    doc.autoTable({ head, body, startY: 36 });
    doc.save("zeiterfassung.pdf");
  };

  const onLogoFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => setLogoDataUrl(e.target.result);
    reader.readAsDataURL(file);
  };

  // Anzeige-Hilfen
  const myVacations = useMemo(
    () =>
      currentEmployee
        ? vacations.filter((v) => v.employeeId === currentEmployee.id)
        : [],
    [vacations, currentEmployee]
  );

  return (
    <div style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      <h2>Digitale Zeiterfassung</h2>

      {/* ---------- Login ---------- */}
      {!role && (
        <section>
          <h3>Login</h3>
          <div style={{ display: "grid", gap: 8, maxWidth: 360 }}>
            <strong>Mitarbeiter</strong>
            <input
              placeholder="Name"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
            />
            <input
              type="password"
              placeholder="Passwort"
              value={empPw}
              onChange={(e) => setEmpPw(e.target.value)}
            />
            <button onClick={handleEmployeeLogin}>Mitarbeiter Login</button>

            <div style={{ margin: "8px 0", opacity: 0.6 }}>— oder —</div>

            <strong>Admin</strong>
            <input
              type="password"
              placeholder="Admin-Passwort"
              value={loginPw}
              onChange={(e) => setLoginPw(e.target.value)}
            />
            <button onClick={handleLogin}>Admin Login</button>
          </div>
        </section>
      )}

      {/* ---------- Mitarbeiter-Ansicht ---------- */}
      {role === "employee" && currentEmployee && (
        <section style={{ marginTop: 16 }}>
          <h3>Zeiterfassung für {currentEmployee.name}</h3>
          <button onClick={handleLogout} style={{ marginBottom: 8 }}>
            Logout
          </button>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
            >
              <option value="">Projekt wählen</option>
              {projects.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button onClick={handleStart} disabled={!selectedProject || !!startTime}>
              Start
            </button>
            <button onClick={handleStop} disabled={!startTime}>
              Stop
            </button>
            {startTime && <span>Gestartet: {fmtTime(startTime.toISOString())}</span>}
          </div>

          <h4 style={{ marginTop: 16 }}>Zuletzt erfasste Zeiten</h4>
          {records.length === 0 ? (
            <p>Noch keine Einträge</p>
          ) : (
            <ul>
              {records
                .slice()
                .reverse()
                .slice(0, 20)
                .map((r, i) => (
                  <li key={i}>
                    {r.date} | {r.employee} | {r.project} | {fmtTime(r.startISO)}–{fmtTime(r.endISO)} | {r.duration} Min{" "}
                    {r.lunchApplied ? "(Pause abgezogen)" : ""}
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
              <li key={v.id}>
                {v.startDate} – {v.endDate} → {v.status}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------- Admin-Ansicht ---------- */}
      {role === "admin" && (
        <section style={{ marginTop: 16 }}>
          <h3>Admin-Ansicht</h3>
          <button onClick={handleLogout}>Logout</button>

          <h4 style={{ marginTop: 16 }}>Mitarbeiter</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input
              placeholder="Name"
              value={newEmpName}
              onChange={(e) => setNewEmpName(e.target.value)}
            />
            <input
              type="password"
              placeholder="Passwort"
              value={newEmpPw}
              onChange={(e) => setNewEmpPw(e.target.value)}
            />
            <button onClick={addEmployee}>Hinzufügen</button>
          </div>
          <ul>
            {employees.map((emp) => (
              <li key={emp.id}>
                {emp.name} {emp.active ? "" : "(inaktiv)"}{" "}
                <button onClick={() => toggleEmployee(emp.id)}>
                  {emp.active ? "Deaktivieren" : "Aktivieren"}
                </button>{" "}
                {/* Optional: Löschfunktion für Mitarbeiter */}
              </li>
            ))}
          </ul>

          <h4 style={{ marginTop: 16 }}>Projekte</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input
              placeholder="Neues Projekt"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
            />
            <button onClick={addProject}>Hinzufügen</button>
          </div>
          <ul>
            {projects.map((p) => (
              <li key={p.id}>
                {p.name} <button onClick={() => removeProject(p.id)}>Löschen</button>
              </li>
            ))}
          </ul>

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

          <h4 style={{ marginTop: 16 }}>Exporte</h4>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={exportCSV} disabled={!records.length}>
              CSV
            </button>
            <button onClick={exportExcel} disabled={!records.length}>
              Excel
            </button>
            <button onClick={exportPDF} disabled={!records.length}>
              PDF
            </button>
          </div>

          <div style={{ marginTop: 10 }}>
            <label>Logo für PDF: </label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => onLogoFile(e.target.files?.[0])}
            />
          </div>

          <h4 style={{ marginTop: 16 }}>Sicherung</h4>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => {
                const payload = {
                  version: 3,
                  exportedAt: new Date().toISOString(),
                  // Stammdaten sind jetzt zentral in Supabase – Backup enthält lokale Daten:
                  records,
                  vacations,
                  logoDataUrl: logoDataUrl || null,
                };
                const blob = new Blob([JSON.stringify(payload, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "zeiterfassung-backup.json";
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Backup herunterladen (JSON)
            </button>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <input
                type="file"
                accept="application/json"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (data.records) setRecords(Array.isArray(data.records) ? data.records : []);
                    if (data.vacations)
                      setVacations(Array.isArray(data.vacations) ? data.vacations : []);
                    if (data.logoDataUrl) setLogoDataUrl(String(data.logoDataUrl));
                    alert("Backup importiert ✅");
                  } catch (err) {
                    alert("Import fehlgeschlagen: " + err.message);
                  }
                }}
              />
              Backup importieren (JSON)
            </label>
          </div>
        </section>
      )}
    </div>
  );
}
