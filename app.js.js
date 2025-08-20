// Firebase (ES-moduler fra CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import {
  getFirestore, collection, addDoc, onSnapshot, orderBy, query,
  deleteDoc, doc, getDocs, getDoc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

// === Firebase-config ===
const firebaseConfig = {
  apiKey: "AIzaSyCIpIWcUGuHIMWM8gXYnyY8-crXNrC5HwI",
  authDomain: "beskjedapp.firebaseapp.com",
  projectId: "beskjedapp",
  storageBucket: "beskjedapp.firebasestorage.app",
  messagingSenderId: "931659490429",
  appId: "1:931659490429:web:4068a43ae6d5dc8d273d14",
  measurementId: "G-82PCVFDZ3L"
};

console.log("[App] Laster…");
const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

/* ---------------------------------------------------------
   TILGANGER (nøkler)
--------------------------------------------------------- */
const PERMS = [
  "view_info",
  "view_messages", "add_message", "delete_message",
  "view_arrangements", "add_arrangement",
  "manage_users"
];

// Map sider → påkrevd rettighet
const PAGE_PERM = {
  "info-page": "view_info",
  "messages-page": "view_messages",
  "arrangementer-page": "view_arrangements",
  "users-page": "manage_users",
};

// Session
export let currentUser = null; // { id, username, displayName, permissions:[], canManageUsers, ... }
window.currentUser = currentUser; // for index.html hook

/* ---------------------------------------------------------
   INIT: opprett ADMIN hvis users-kolleksjonen er tom
--------------------------------------------------------- */
async function ensureAdminUser() {
  const usersRef = collection(db, "users");
  const snap = await getDocs(usersRef);
  if (!snap.empty) return; // finnes allerede brukere

  const adminDoc = doc(usersRef, "admin"); // bruker fast id = admin
  await setDoc(adminDoc, {
    username: "admin",
    password: "Admin1996", // kan ikke endres i UI
    firstName: "System",
    lastName: "Administrator",
    email: "admin@example.com",
    phone: "00000000",
    displayName: "Administrator",
    system: true, // kan ikke slettes
    canManageUsers: true,
    permissions: PERMS, // full tilgang
    createdAt: serverTimestamp()
  });
  console.log("[Init] Admin opprettet");
}

/* ---------------------------------------------------------
   HJELPERE
--------------------------------------------------------- */
function todayLocalISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function sameLocalDay(isoDateTime) {
  const t = new Date(isoDateTime);
  const td = todayLocalISO();
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}` === td;
}
function inPeriodInclusive(todayISO, startISO, endISO) {
  if (!startISO || !endISO) return false;
  return (todayISO >= startISO && todayISO <= endISO);
}
function hasPerm(p) {
  if (!currentUser) return false;
  return (currentUser.permissions || []).includes(p);
}
function showNoAccess() {
  document.getElementById("noaccess-overlay").style.display = "flex";
}
window.closeNoAccess = function(){ document.getElementById("noaccess-overlay").style.display = "none"; };

/* ---------------------------------------------------------
   LOGIN / LOGOUT / NAVIGASJON
   (passord lagres i Firestore enkelt – ikke produksjonssikkert)
--------------------------------------------------------- */
window.login = async function () {
  await ensureAdminUser();

  const username = (document.getElementById("username").value || "").trim();
  const password = document.getElementById("password").value;
  const err = document.getElementById("login-error");

  // finn bruker med dokument-id == username (vi bruker det som id)
  const uref = doc(db, "users", username);
  const usnap = await getDoc(uref);
  if (!usnap.exists() || usnap.data().password !== password) {
    err.textContent = "Feil brukernavn eller passord!";
    return;
  }

  currentUser = { id: uref.id, ...usnap.data() };
  window.currentUser = currentUser; // for ikon-hook
  document.getElementById("whoami").textContent =
    `${currentUser.displayName || (currentUser.firstName + " " + currentUser.lastName)} (${currentUser.username})`;

  // vis app
  document.getElementById("login-container").style.display = "none";
  document.getElementById("app-container").style.display = "block";

  // start datalytt (meldinger)
  subscribeMessages();

  // default-side: første vi har tilgang til
  const firstAllowed = Object.keys(PAGE_PERM).find(p => hasPerm(PAGE_PERM[p])) || "info-page";
  document.getElementById("nav-select").value = firstAllowed;
  navigate();

  err.textContent = "";
};

window.logout = function () {
  currentUser = null;
  window.currentUser = null;
  document.getElementById("app-container").style.display = "none";
  document.getElementById("login-container").style.display = "block";
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  document.getElementById("login-error").textContent = "";
};

window.navigate = function () {
  const selected = document.getElementById("nav-select").value;
  const need = PAGE_PERM[selected];
  if (need && !hasPerm(need)) {
    showNoAccess();
    // hopp tilbake til info (om lov), ellers første tillatte
    const fallback = hasPerm("view_info") ? "info-page" :
      (Object.keys(PAGE_PERM).find(p => hasPerm(PAGE_PERM[p])) || "info-page");
    document.getElementById("nav-select").value = fallback;
    document.querySelectorAll(".page").forEach(el => el.style.display = "none");
    document.getElementById(fallback).style.display = "block";
    return;
  }
  document.querySelectorAll(".page").forEach(el => el.style.display = "none");
  document.getElementById(selected).style.display = "block";

  if (selected === "users-page") mountUsersAdmin();
};

/* ---------------------------------------------------------
   BESKJEDER
--------------------------------------------------------- */
let unsubscribeMsgs = null;

function subscribeMessages() {
  if (unsubscribeMsgs) unsubscribeMsgs();
  const q = query(collection(db, "messages"), orderBy("createdAt", "asc"));
  unsubscribeMsgs = onSnapshot(q, renderMessages, (err)=>console.error(err));
}

function renderMessages(snapshot) {
  const list = document.getElementById("messages-list");
  list.innerHTML = "";

  const today = todayLocalISO();

  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    if (!inPeriodInclusive(today, data.startDate, data.endDate)) return;

    const li = document.createElement("li");
    li.className = "message";

    const text = document.createElement("div");
    const createdStr = data.createdAt ? new Date(data.createdAt).toLocaleString() : "";
    text.innerHTML = `<div>${data.text}</div>
      <div class="meta">
        Av: <strong>${data.authorDisplayName}</strong> (${data.authorUsername})
        &nbsp;|&nbsp; Lagt: ${createdStr}
        &nbsp;|&nbsp; Gjelder: ${data.startDate} – ${data.endDate}
      </div>`;

    const actions = document.createElement("div");
    actions.className = "actions";

    // merke Avarn/Malling
    const au = (data.authorUsername || "").toLowerCase();
    const ad = (data.authorDisplayName || "").toLowerCase();
    if (au.includes("avarn") || ad.includes("avarn")) {
      const b = document.createElement("span"); b.className="badge"; b.textContent="Avarn"; actions.appendChild(b);
    } else if (au.includes("malling") || ad.includes("malling")) {
      const b = document.createElement("span"); b.className="badge"; b.textContent="Malling"; actions.appendChild(b);
    }

    if (canDeleteMsg(data)) {
      const del = document.createElement("button");
      del.textContent = "Slett";
      del.className = "danger";
      del.onclick = () => openConfirm(docSnap.id, data);
      actions.appendChild(del);
    }

    li.appendChild(text);
    li.appendChild(actions);
    list.appendChild(li);
  });

  // Deaktiver/aktiver "Send" etter rettighet
  document.getElementById("send-btn").disabled = !hasPerm("add_message");
}

window.sendMessage = async function () {
  if (!hasPerm("add_message")) { showNoAccess(); return; }

  const t = document.getElementById("message-text").value.trim();
  const start = document.getElementById("start-date").value;
  const end = document.getElementById("end-date").value;
  const err = document.getElementById("form-error");

  if (!currentUser) { err.textContent = "Du må være innlogget."; return; }
  if (!t) { err.textContent = "Skriv en beskjed."; return; }
  if (!start || !end) { err.textContent = "Velg gyldig periode (fra og til)."; return; }
  if (end < start) { err.textContent = "Sluttdato kan ikke være før startdato."; return; }

  try {
    await addDoc(collection(db, "messages"), {
      text: t,
      authorUsername: currentUser.username,
      authorDisplayName: currentUser.displayName || (currentUser.firstName + " " + currentUser.lastName),
      createdAt: new Date().toISOString(),
      startDate: start,
      endDate: end
    });

    document.getElementById("message-text").value = "";
    document.getElementById("start-date").value = "";
    document.getElementById("end-date").value = "";
    err.textContent = "";
  } catch (e) {
    console.error(e);
    err.textContent = "Kunne ikke lagre beskjeden (sjekk nett/konfig).";
  }
};

function canDeleteMsg(msg) {
  if (!currentUser) return false;
  if (!hasPerm("delete_message")) return false;

  // I tillegg: forfatter samme dag kan slette selv
  const me = currentUser.username;
  const authorU = (msg.authorUsername || "");
  const isAuthorSameDay = me === authorU && sameLocalDay(msg.createdAt);
  return isAuthorSameDay || hasPerm("delete_message");
}

// popup for sletting
let pendingDelete = { id: null, data: null };
function openConfirm(id, data) {
  pendingDelete = { id, data };
  document.getElementById("confirm-overlay").style.display = "flex";
  const btn = document.getElementById("confirm-delete-btn");
  btn.onclick = async () => {
    await performDelete();
    closeConfirm();
  };
}
window.closeConfirm = function () {
  document.getElementById("confirm-overlay").style.display = "none";
  pendingDelete = { id: null, data: null };
};
async function performDelete() {
  if (!pendingDelete.id || !pendingDelete.data) return;
  if (!canDeleteMsg(pendingDelete.data)) { showNoAccess(); return; }
  try { await deleteDoc(doc(db, "messages", pendingDelete.id)); }
  catch(e){ console.error("Delete failed:", e); }
}

/* ---------------------------------------------------------
   BRUKERADMIN
--------------------------------------------------------- */
let unsubUsers = null, unsubPkgs = null;

function mountUsersAdmin(){
  if (!hasPerm("manage_users")) { showNoAccess(); return; }

  // tegn alle rettigheter i "Ny bruker"
  const cont = document.getElementById("nu-perms");
  cont.innerHTML = "";
  PERMS.forEach(p=>{
    const id = `nu-p-${p}`;
    const w = document.createElement("label");
    w.className = "check";
    w.innerHTML = `<input type="checkbox" id="${id}" value="${p}"> <span>${p}</span>`;
    cont.appendChild(w);
  });
  // tegn rettigheter i pakke-editor
  const pkgSelectList = document.getElementById("pkg-perms");
  pkgSelectList.innerHTML = "";
  PERMS.forEach(p=>{
    const o=document.createElement("option"); o.value=p; o.textContent=p; pkgSelectList.appendChild(o);
  });

  // last pakker
  if (unsubPkgs) unsubPkgs();
  unsubPkgs = onSnapshot(collection(db,"permissionPackages"), snap=>{
    const ul=document.getElementById("pkg-list"); ul.innerHTML="";
    const choose = document.getElementById("nu-package");
    choose.innerHTML = `<option value="">(ingen)</option>`;
    snap.forEach(d=>{
      const pkg=d.data();
      const li=document.createElement("li"); li.className="message";
      li.innerHTML = `<div><strong>${pkg.name}</strong><div class="meta">${(pkg.permissions||[]).join(", ")||"(tom)"}</div></div>`;
      // liten slett-knapp
      const act=document.createElement("div"); act.className="actions";
      const del=document.createElement("button"); del.className="danger"; del.textContent="Slett";
      del.onclick = ()=> deleteDoc(doc(db,"permissionPackages",d.id));
      act.appendChild(del); li.appendChild(act); ul.appendChild(li);

      const opt = document.createElement("option"); opt.value=d.id; opt.textContent=pkg.name; choose.appendChild(opt);
    });
  });

  // last brukere
  if (unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(collection(db,"users"), snap=>{
    const ul=document.getElementById("users-list"); ul.innerHTML="";
    snap.forEach(d=>{
      const u = d.data(); const id=d.id;
      const li = document.createElement("li"); li.className="message";
      const meta = `<div class="meta">${u.email} • ${u.phone} • Rettigheter: ${(u.permissions||[]).join(", ")}</div>`;
      li.innerHTML = `<div><strong>${u.displayName || (u.firstName+" "+u.lastName)}</strong> (${u.username}) ${u.system?'<span class="badge">SYSTEM</span>':''}${meta}</div>`;

      const actions = document.createElement("div"); actions.className="actions";
      const edit = document.createElement("button"); edit.className="secondary"; edit.textContent="Rediger";
      edit.onclick = ()=> openEditUser(id, u);
      actions.appendChild(edit);

      if (!u.system){ // admin/system kan ikke slettes
        const del = document.createElement("button"); del.className="danger"; del.textContent="Slett";
        del.onclick = ()=> { if(confirm("Slette bruker?")) deleteDoc(doc(db,"users",id)); };
        actions.appendChild(del);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    });
  });
}

// lagre pakke
window.savePackage = async function(){
  const name = (document.getElementById("pkg-name").value||"").trim();
  const select = document.getElementById("pkg-perms");
  const perms = Array.from(select.selectedOptions).map(o=>o.value);
  if(!name){ document.getElementById("pkg-msg").textContent="Skriv navn"; return; }
  await addDoc(collection(db,"permissionPackages"), { name, permissions: perms, createdAt: serverTimestamp() });
  document.getElementById("pkg-name").value = "";
  document.getElementById("pkg-msg").textContent = "Lagret.";
  setTimeout(()=>document.getElementById("pkg-msg").textContent="",1500);
};

// opprette ny bruker
window.createUser = async function(){
  if (!hasPerm("manage_users")) { showNoAccess(); return; }

  const first = (document.getElementById("nu-first").value||"").trim();
  const last  = (document.getElementById("nu-last").value||"").trim();
  const email = (document.getElementById("nu-email").value||"").trim();
  const phone = (document.getElementById("nu-phone").value||"").trim();
  const username = (document.getElementById("nu-username").value||"").trim() || `${first}.${last}`.toLowerCase();
  const password = (document.getElementById("nu-password").value||"").trim() || "Velkommen1!";
  const pkgId = document.getElementById("nu-package").value;
  const canManage = document.getElementById("nu-canmanage").checked;
  const errEl = document.getElementById("nu-error");

  if(!first || !last || !email || !phone){
    errEl.textContent = "Fornavn, Etternavn, E-post og Telefon må fylles ut.";
    return;
  }

  // samle perms
  let perms = [];
  if (pkgId){
    const p = await getDoc(doc(db,"permissionPackages",pkgId));
    if (p.exists()) perms = (p.data().permissions||[]);
  }
  const extra = Array.from(document.querySelectorAll("#nu-perms input[type=checkbox]:checked")).map(c=>c.value);
  perms = Array.from(new Set([ ...perms, ...extra, "view_info" ])); // alltid kunne se info

  // avatar (valgfritt) → dataURL
  const fileInput = document.getElementById("nu-avatar");
  let avatarData = "";
  if (fileInput.files && fileInput.files[0]){
    avatarData = await fileToDataURL(fileInput.files[0]);
  }

  // opprett dokument-id = username (enkelt å slå opp ved login)
  await setDoc(doc(db,"users",username), {
    username, password,
    firstName:first, lastName:last,
    email, phone,
    displayName: `${first} ${last}`,
    permissions: perms,
    canManageUsers: canManage,
    avatarUrl: avatarData || "",
    createdAt: serverTimestamp()
  });

  // nullstill
  ["nu-first","nu-last","nu-email","nu-phone","nu-username","nu-password"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("nu-canmanage").checked=false;
  document.getElementById("nu-package").value="";
  document.querySelectorAll("#nu-perms input[type=checkbox]").forEach(c=>c.checked=false);
  document.getElementById("nu-avatar").value="";
  errEl.textContent = "";
};

// redigering (enkel inline-popup via prompt – kort og funksjonelt)
async function openEditUser(id, u){
  if (!hasPerm("manage_users")) { showNoAccess(); return; }

  const email = prompt("E-post:", u.email || "") ?? u.email;
  const phone = prompt("Telefon:", u.phone || "") ?? u.phone;

  // endre passord (ikke for admin/system)
  let password = u.password;
  if(!u.system){
    const p = prompt("Passord (la stå tomt for uendret):", "");
    if (p && p.trim()) password = p.trim();
  }

  // endre rettigheter – enkel komma-liste
  const permText = prompt("Rettigheter (komma-separert)", (u.permissions||[]).join(", "));
  const perms = (permText||"").split(",").map(s=>s.trim()).filter(Boolean);

  await updateDoc(doc(db,"users",id), {
    email, phone,
    password, // for admin/system vil verdien være uendret
    permissions: perms
  });
}

function fileToDataURL(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------
  KLAR VED LAST
--------------------------------------------------------- */
ensureAdminUser();
