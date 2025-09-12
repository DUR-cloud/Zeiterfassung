// src/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  const msg = "FEHLENDE ENV Variablen: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (Production).";
  // Zeige es direkt im DOM (falls App noch nicht mounted)
  const root = document.getElementById("root") || document.body;
  const pre = document.createElement("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.padding = "12px";
  pre.style.background = "#f8d7da";
  pre.style.border = "1px solid #f5c6cb";
  pre.style.color = "#721c24";
  pre.textContent = msg;
  root.innerHTML = "";
  root.appendChild(pre);
  throw new Error(msg);
}

export const supabase = createClient(url, key, {
  realtime: { params: { eventsPerSecond: 5 } },
});


const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Fehlende ENV Variablen: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
