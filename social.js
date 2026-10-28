// ─────────────────────────────────────────────────────────────
// Study Savvy: accounts, onboarding, usernames, flairs, friends
// Loaded as a module AFTER the main Firebase module in index.html,
// so it reuses the same Firebase app instance.
// ─────────────────────────────────────────────────────────────
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
    createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification,
    sendPasswordResetEmail, updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, query,
    where, orderBy, startAt, endAt, limit, getDocs, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = getApp();
const auth = getAuth(app);
const fs = getFirestore(app);

// The author account. The Firestore rules enforce the same check server-side,
// so editing this line in the browser does not let anyone else use the F1 flair.
const AUTHOR_EMAIL = 'satvik.garg29@gmail.com';
const ONBOARD_KEY = 'ss_onboarded_v1';
const USERNAME_RE = /^(?!.*\.\.)[a-z0-9_][a-z0-9_.]{1,18}[a-z0-9_]$/; // no leading/trailing/double dots (must also work as an email local part)
// Username + password accounts: Firebase Auth needs an email, so each username maps to an
// address under this project's own domain. No email is ever sent to it.
const LOGIN_DOMAIN = 'users.study-savvy-fr.firebaseapp.com';
function loginEmail(u) { return u + '@' + LOGIN_DOMAIN; }
function loginNameOf(user) { const e = (user && user.email) || ''; return e.endsWith('@' + LOGIN_DOMAIN) ? e.split('@')[0] : null; }

const PALETTE = {
    grey:   { bg: '#3a3a40', fg: '#ececec', name: 'Grey' },
    red:    { bg: '#e05252', fg: '#ffffff', name: 'Red' },
    orange: { bg: '#f08c00', fg: '#111111', name: 'Orange' },
    yellow: { bg: '#f5c518', fg: '#111111', name: 'Yellow' },
    green:  { bg: '#2ecc71', fg: '#0a0a0a', name: 'Green' },
    teal:   { bg: '#00c49a', fg: '#0a0a0a', name: 'Teal' },
    blue:   { bg: '#3b82f6', fg: '#ffffff', name: 'Blue' },
    purple: { bg: '#8b5cf6', fg: '#ffffff', name: 'Purple' },
    pink:   { bg: '#e64980', fg: '#ffffff', name: 'Pink' }
};

// ── state ──
const S = {
    authReady: false,
    user: null,
    profile: undefined,     // undefined = loading, null = none yet
    profileErr: null,
    privacy: null,
    authMode: 'signin',     // 'signin' | 'signup' | 'reset'
    slide: 0,
    touring: false,
    friendships: {},        // pairId -> data
    profiles: {},           // uid -> profile
    stats: {},              // uid -> stats object | 'hidden'
    lbRange: 'today',
    compareUid: null,
    unsubs: { profile: null, privacy: null, friendships: null, friendProfiles: {}, friendStats: {} },
    liveSince: null,
    lastStatsJSON: '',
    resendAt: 0
};

// ── helpers ──
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function pad2(n) { return String(n).padStart(2, '0'); }
function keyOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayKey() { return keyOf(new Date()); }
function mondayKey() { const d = new Date(); const day = d.getDay(); d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); return keyOf(d); }
function monthKey() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function pairId(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
function otherUid(f) { return f.users[0] === S.user.uid ? f.users[1] : f.users[0]; }
function fmtMins(m) { m = Math.round(m || 0); const h = Math.floor(m / 60), r = m % 60; if (h === 0) return r + 'm'; return h + 'h ' + pad2(r) + 'm'; }
function toast(msg) { if (window.notify) window.notify(msg); }
function isAuthor() { return !!(S.user && S.user.email === AUTHOR_EMAIL && S.user.emailVerified); }
function isPasswordUser(u) { return u && u.providerData.some(p => p.providerId === 'password') && !u.providerData.some(p => p.providerId === 'google.com'); }
function initial(p) { const n = (p && (p.displayName || p.username)) || '?'; return esc(n.trim().charAt(0).toUpperCase() || '?'); }
function avatarColor(uid) { const cols = ['#00c49a','#3b82f6','#8b5cf6','#e64980','#f08c00','#2ecc71','#f5c518','#e05252']; let h = 0; for (let i = 0; i < (uid || '').length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0; return cols[h % cols.length]; }

function authErr(e) {
    const c = (e && e.code) || '';
    const map = {
        'auth/invalid-credential': 'Username or password is incorrect.',
        'auth/wrong-password': 'Username or password is incorrect.',
        'auth/user-not-found': 'Username or password is incorrect.',
        'auth/email-already-in-use': 'That username is taken. Try another.',
        'auth/weak-password': 'Password is too weak. Use at least 8 characters with letters and numbers.',
        'auth/invalid-email': 'That email address does not look right.',
        'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
        'auth/operation-not-allowed': 'This sign-in method is not enabled yet.',
        'auth/network-request-failed': 'Network error. Check your connection.',
        'auth/account-exists-with-different-credential': 'This email is already registered with a different sign-in method.',
        'auth/password-does-not-meet-requirements': 'Password needs at least 8 characters, including letters and numbers.'
    };
    return map[c] || (e && e.message ? e.message.replace('Firebase: ', '') : 'Something went wrong.');
}

// ── Flairs ──
let f1Count = 0;
function f1FlairSVG() {
    const id = 'f1x' + (f1Count++);
    const body = 'M11,25 L13,16 L28,14 L40,10 L52,9 L57,13 L61,16 L74,16 L82,14 L120,17 L148,22 L151,25 L140,27.5 L118,28.5 L38,28.5 L18,28.5 Z';
    return '<span class="flair-f1" title="simply lovely (author)">' +
        '<svg viewBox="-16 2 176 32" aria-hidden="true">' +
        '<defs>' +
            '<linearGradient id="' + id + 'b" x1="0" x2="1"><stop offset="0" stop-color="#0b1f4d"/><stop offset=".5" stop-color="#1b3a8f"/><stop offset="1" stop-color="#0b1f4d"/></linearGradient>' +
            '<linearGradient id="' + id + 'o" x1="0" x2="1"><stop offset="0" stop-color="#ff5a00"/><stop offset="1" stop-color="#ffb020"/></linearGradient>' +
            '<linearGradient id="' + id + 's" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
            '<clipPath id="' + id + 'c"><path d="' + body + '"/></clipPath>' +
        '</defs>' +
        '<g class="f1-speed"><line x1="4" y1="12" x2="-12" y2="12"/><line x1="6" y1="19" x2="-16" y2="19"/><line x1="4" y1="26" x2="-10" y2="26"/></g>' +
        // rear wing
        '<rect x="6" y="5" width="4" height="21" rx="1" fill="#0b1f4d"/>' +
        '<rect x="3" y="4.5" width="21" height="3.6" rx="1" fill="url(#' + id + 'o)"/>' +
        // body
        '<path d="' + body + '" fill="url(#' + id + 'b)"/>' +
        '<rect x="36" y="25.4" width="86" height="2" fill="url(#' + id + 'o)" clip-path="url(#' + id + 'c)"/>' +
        '<path d="M120,17 L148,22 L151,25 L140,27.5 L130,27 Z" fill="url(#' + id + 'o)"/>' +
        '<g clip-path="url(#' + id + 'c)"><rect class="f1-sheen" x="0" y="0" width="34" height="36" fill="url(#' + id + 's)"/></g>' +
        // helmet + halo
        '<circle cx="66" cy="13" r="3.6" fill="#ffd21f"/>' +
        '<path d="M58,13 Q66,6 77,14" stroke="#0a0a0a" stroke-width="1.7" fill="none"/>' +
        // name on the body
        // front wing
        '<rect x="136" y="28" width="22" height="3" rx="1" fill="url(#' + id + 'o)"/>' +
        '<rect x="154.5" y="23" width="3" height="8" rx="1" fill="#0b1f4d"/>' +
        // wheels
        '<g><circle cx="30" cy="27" r="8" fill="#111" stroke="#2c2c2c" stroke-width="1.5"/><g class="f1-wheel"><circle cx="30" cy="27" r="3.4" fill="#555"/><line x1="30" y1="23.6" x2="30" y2="30.4" stroke="#999" stroke-width="1"/></g></g>' +
        '<g><circle cx="126" cy="27" r="7" fill="#111" stroke="#2c2c2c" stroke-width="1.5"/><g class="f1-wheel"><circle cx="126" cy="27" r="3" fill="#555"/><line x1="126" y1="24" x2="126" y2="30" stroke="#999" stroke-width="1"/></g></g>' +
        '</svg><b>simply lovely</b></span>';
}
function flairHTML(f) {
    if (!f) return '';
    if (f.color === 'f1') return f1FlairSVG();
    if (!f.text) return '';
    const c = PALETTE[f.color] || PALETTE.grey;
    return '<span class="flair" style="background:' + c.bg + ';color:' + c.fg + '">' + esc(f.text) + '</span>';
}
function nameLine(p, uid) {
    if (!p) return '<span class="fr-name">Loading…</span>';
    return '<span class="fr-name">' + esc(p.displayName || p.username) + ' ' + flairHTML(p.flair) + '</span><div class="fr-user">@' + esc(p.username) + '</div>';
}
function avatarHTML(p, uid, sm) {
    return '<div class="fr-avatar' + (sm ? ' sm' : '') + '" style="background:' + avatarColor(uid) + '">' + initial(p) + '</div>';
}

// ═════════════════════════════════════════════
// GATE: onboarding slides → auth → verify → username
// ═════════════════════════════════════════════
const SLIDES = [
    {
        title: 'Track every minute',
        text: 'Start a stopwatch, a countdown, or Pomodoro cycles. Every session is saved to the category you are working on.',
        list: ['Categories auto-switch by time of day', 'Pop the timer out with picture-in-picture', 'Syncs across your phone and laptop'],
        art: '<svg viewBox="0 0 220 150"><circle cx="110" cy="75" r="58" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10"/><circle cx="110" cy="75" r="58" fill="none" stroke="#00c49a" stroke-width="10" stroke-linecap="round" stroke-dasharray="364" stroke-dashoffset="110" transform="rotate(-90 110 75)"/><text x="110" y="82" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="20" fill="#f5f5f5">01:24:07</text><text x="110" y="102" text-anchor="middle" font-family="DM Sans" font-size="10" fill="#787878">Day Study</text></svg>'
    },
    {
        title: 'Aim, then beat it',
        text: 'Set a daily aim for each category and watch the bars fill up. History and weekday comparisons show how you are trending.',
        list: ['Daily aims with default goals per weekday', 'Full history of every session', 'Streaks for showing up every day'],
        art: '<svg viewBox="0 0 220 150"><g font-family="DM Sans" font-size="10" fill="#c8c8c8"><circle cx="30" cy="40" r="4" fill="#00c49a"/><text x="40" y="44">Day Study</text><rect x="30" y="52" width="160" height="6" rx="3" fill="rgba(255,255,255,0.08)"/><rect x="30" y="52" width="130" height="6" rx="3" fill="#00c49a"/><circle cx="30" cy="80" r="4" fill="#d63384"/><text x="40" y="84">Evening Study</text><rect x="30" y="92" width="160" height="6" rx="3" fill="rgba(255,255,255,0.08)"/><rect x="30" y="92" width="80" height="6" rx="3" fill="#d63384"/><circle cx="30" cy="120" r="4" fill="#d4a017"/><text x="40" y="124">Career Work</text><rect x="30" y="132" width="160" height="6" rx="3" fill="rgba(255,255,255,0.08)"/><rect x="30" y="132" width="160" height="6" rx="3" fill="#d4a017"/></g></svg>'
    },
    {
        title: 'Study with friends',
        text: 'Pick a username, find your friends by theirs, and send a request. Once they accept, you can compare study time on a shared leaderboard.',
        list: ['Leaderboard for today, this week, or this month', 'See who is studying right now', 'Side-by-side chart of the last 7 days'],
        art: '<svg viewBox="0 0 220 150"><g font-family="DM Sans" font-size="11"><rect x="20" y="18" width="180" height="34" rx="9" fill="rgba(255,255,255,0.05)"/><circle cx="40" cy="35" r="10" fill="#3b82f6"/><text x="58" y="39" fill="#f5f5f5">@aisha</text><text x="190" y="39" text-anchor="end" fill="#f5f5f5" font-family="JetBrains Mono">4h 12m</text><rect x="20" y="58" width="180" height="34" rx="9" fill="rgba(0,196,154,0.10)"/><circle cx="40" cy="75" r="10" fill="#00c49a"/><text x="58" y="79" fill="#f5f5f5">you</text><circle cx="88" cy="75" r="3.5" fill="#2ecc71"/><text x="190" y="79" text-anchor="end" fill="#f5f5f5" font-family="JetBrains Mono">3h 40m</text><rect x="20" y="98" width="180" height="34" rx="9" fill="rgba(255,255,255,0.05)"/><circle cx="40" cy="115" r="10" fill="#e64980"/><text x="58" y="119" fill="#f5f5f5">@dev.k</text><text x="190" y="119" text-anchor="end" fill="#f5f5f5" font-family="JetBrains Mono">2h 05m</text></g></svg>'
    },
    {
        title: 'Your time, your rules',
        text: 'You decide who sees your study time: all friends, only the ones you pick, or nobody. Make your profile yours with a flair.',
        list: ['Per-friend visibility switches', 'Reddit-style flairs in your colour', 'Your private data stays locked to your account'],
        art: '<svg viewBox="0 0 220 150"><g transform="translate(78,18)"><rect x="6" y="34" width="52" height="42" rx="8" fill="#00c49a"/><path d="M16,34 V24 a16,16 0 0 1 32,0 V34" fill="none" stroke="#00c49a" stroke-width="7"/><circle cx="32" cy="52" r="5" fill="#0a0a0a"/><rect x="30" y="54" width="4" height="10" rx="2" fill="#0a0a0a"/></g><g font-family="DM Sans" font-size="10" font-weight="600"><rect x="22" y="112" width="58" height="18" rx="9" fill="#8b5cf6"/><text x="51" y="124" text-anchor="middle" fill="#fff">grinding</text><rect x="86" y="112" width="52" height="18" rx="9" fill="#f5c518"/><text x="112" y="124" text-anchor="middle" fill="#111">ECE 2T9</text><rect x="144" y="112" width="54" height="18" rx="9" fill="#e64980"/><text x="171" y="124" text-anchor="middle" fill="#fff">caffeine</text></g></svg>'
    }
];

function gateEl() { return $('ssGate'); }
function showGate(html) {
    const g = gateEl();
    g.innerHTML = '<div class="ss-gate-inner"><div class="ss-brand">Study Savvy</div><div class="ss-brand-sub">mehnat kar, ho jata hai.</div>' + html + '</div>';
    g.hidden = false;
    document.body.style.overflow = 'hidden';
}
function hideGate() { gateEl().hidden = true; document.body.style.overflow = ''; }

function route() {
    if (S.touring) return renderSlides();
    if (!S.authReady) return showGate('<div class="ss-box"><div class="ss-loading">Loading…</div></div>');
    if (!S.user) {
        let onboarded = false;
        try { onboarded = localStorage.getItem(ONBOARD_KEY) === '1'; } catch (e) {}
        return onboarded ? renderAuth() : renderSlides();
    }
    if (S.profileErr) return showGate('<div class="ss-box"><div class="ss-msg err">Could not load your profile: ' + esc(S.profileErr) + '</div><div class="ss-row" style="margin-top:12px;"><button class="btn btn-ghost btn-sm" onclick="location.reload()">Retry</button><button class="ss-link" data-act="signout">Sign out</button></div></div>');
    if (S.profile === undefined) return showGate('<div class="ss-box"><div class="ss-loading">Loading your profile…</div></div>');
    if (S.profile === null && S.pendingClaim) return showGate('<div class="ss-box"><div class="ss-loading">Creating your account…</div></div>');
    if (S.profile === null) return renderSetup();
    hideGate();
    renderFriends();
}

function renderSlides() {
    const s = SLIDES[S.slide];
    const last = S.slide === SLIDES.length - 1;
    const dots = SLIDES.map((_, i) => '<button class="ss-dot' + (i === S.slide ? ' on' : '') + '" data-slide="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>').join('');
    showGate('<div class="ss-box"><div class="ss-slide"><div class="ss-slide-art">' + s.art + '</div><h2>' + s.title + '</h2><p>' + s.text + '</p><ul>' + s.list.map(x => '<li>' + x + '</li>').join('') + '</ul></div>' +
        '<div class="ss-dots">' + dots + '</div>' +
        '<div class="ss-row">' +
            (S.slide > 0 ? '<button class="ss-link" data-act="prev">Back</button>' : '<button class="ss-link" data-act="skip">' + (S.touring ? 'Close' : 'Skip') + '</button>') +
            '<button class="btn btn-accent btn-sm" data-act="' + (last ? 'finishSlides' : 'next') + '">' + (last ? (S.touring ? 'Done' : 'Get started') : 'Next') + '</button>' +
        '</div></div>');
}
function finishSlides() {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
    S.slide = 0;
    S.touring = false;
    route();
}

const GOOGLE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>';

function renderAuth(msg, ok) {
    const up = S.authMode === 'signup';
    const body = '<div class="ss-tabs2"><button class="' + (!up ? 'on' : '') + '" data-mode="signin">Sign in</button><button class="' + (up ? 'on' : '') + '" data-mode="signup">Create account</button></div>' +
        '<form id="ssAuthForm" autocomplete="on">' +
        '<div class="ss-field"><label for="ssUser">Username</label><input class="input" id="ssUser" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required></div>' +
        '<div class="ss-field"><label for="ssPass">Password</label><input class="input" id="ssPass" type="password" autocomplete="' + (up ? 'new-password' : 'current-password') + '" required></div>' +
        (up ? '<div class="ss-field"><label for="ssPass2">Confirm password</label><input class="input" id="ssPass2" type="password" autocomplete="new-password" required></div>' +
              '<div class="ss-hint" style="margin:-4px 0 10px;">Username: 3 to 20 characters, a-z, 0-9, dot, underscore. Password: at least 8 characters with a number. There is no email, so a forgotten password cannot be recovered.</div>' : '') +
        '<button class="btn btn-accent ss-btn-full" type="submit">' + (up ? 'Create account' : 'Sign in') + '</button></form>' +
        '<div class="ss-msg ' + (ok ? 'ok' : 'err') + '" id="ssAuthMsg">' + esc(msg || '') + '</div>' +
        '<div class="ss-or">or</div>' +
        '<button class="btn ss-google" data-act="google">' + GOOGLE_SVG + 'Continue with Google</button>';
    showGate('<div class="ss-box">' + body + '</div><div class="ss-legal">Your study data is private to your account. Friends only see totals you choose to share.<br><button class="ss-link" data-act="tour" style="font-size:10.5px;">See how it works</button></div>');
    const u = $('ssUser');
    u.addEventListener('input', () => { u.value = u.value.toLowerCase().replace(/\s/g, '').replace(/^@/, ''); });
    $('ssAuthForm').addEventListener('submit', onAuthSubmit);
}

async function onAuthSubmit(ev) {
    ev.preventDefault();
    const msgEl = $('ssAuthMsg');
    const btn = ev.target.querySelector('button[type=submit]');
    const setMsg = (t, ok) => { if (!msgEl.isConnected) return; msgEl.textContent = t; msgEl.className = 'ss-msg ' + (ok ? 'ok' : 'err'); };
    const name = ($('ssUser').value || '').trim().toLowerCase().replace(/^@/, '');
    const pw = $('ssPass').value;
    if (!USERNAME_RE.test(name)) { setMsg('Username must be 3 to 20 characters: a-z, 0-9, dot, underscore.'); return; }
    btn.disabled = true; setMsg('');
    try {
        if (S.authMode === 'signup') {
            if (pw.length < 8 || !/[0-9]/.test(pw)) { setMsg('Password needs at least 8 characters, including a number.'); btn.disabled = false; return; }
            if (pw !== $('ssPass2').value) { setMsg('Passwords do not match.'); btn.disabled = false; return; }
            const taken = await getDoc(doc(fs, 'usernames', name));
            if (taken.exists()) { setMsg('@' + name + ' is taken. Try another.'); btn.disabled = false; return; }
            S.pendingClaim = name;
            const cred = await createUserWithEmailAndPassword(auth, loginEmail(name), pw);
            try { await updateProfile(cred.user, { displayName: name }); } catch (e) {}
            try { await claimProfile(cred.user, name, name); }
            catch (e) { console.warn('claim failed', e); route(); } // falls back to the pick-a-username screen
        } else {
            await signInWithEmailAndPassword(auth, loginEmail(name), pw);
        }
    } catch (e) {
        S.pendingClaim = null;
        setMsg(authErr(e));
    }
    if (btn.isConnected) btn.disabled = false;
}

// Creates username + profile + privacy docs in one atomic write
async function claimProfile(user, name, dname) {
    await user.getIdToken(true);
    const uid = user.uid;
    const flair = (user.email === AUTHOR_EMAIL && user.emailVerified) ? { text: 'simply lovely', color: 'f1' } : { text: '', color: 'grey' };
    const b = writeBatch(fs);
    b.set(doc(fs, 'usernames', name), { uid: uid });
    b.set(doc(fs, 'profiles', uid), { username: name, displayName: dname, flair: flair, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b.set(doc(fs, 'privacy', uid), { mode: 'all', allow: [], block: [], showLive: true });
    try { await b.commit(); }
    finally { S.pendingClaim = null; }
}

async function googleSignIn() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
        await signInWithPopup(auth, provider);
    } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
            return signInWithRedirect(auth, provider);
        }
        if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
        const el = $('ssAuthMsg'); if (el) { el.textContent = authErr(e); el.className = 'ss-msg err'; }
    }
}

function renderVerify(msg, ok) {
    showGate('<div class="ss-box"><div style="font-size:15px;font-weight:600;margin-bottom:8px;">Verify your email</div>' +
        '<div class="ss-hint" style="font-size:12.5px;color:var(--text2);">We sent a link to <b>' + esc(S.user.email) + '</b>. Click it, then come back and press Continue. Check your spam folder if you do not see it.</div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;"><button class="btn btn-accent btn-sm" data-act="verified">Continue</button><button class="btn btn-ghost btn-sm" data-act="resend">Resend email</button></div>' +
        '<div class="ss-msg ' + (ok ? 'ok' : 'err') + '">' + esc(msg || '') + '</div>' +
        '<div style="margin-top:10px;"><button class="ss-link" data-act="signout">Use a different account</button></div></div>');
}

function suggestUsername() {
    const base = ((S.user.displayName || (S.user.email || '').split('@')[0]) || '').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 16);
    return base.length >= 3 ? base : '';
}

function renderSetup(msg) {
    const dn = S.user.displayName || '';
    showGate('<div class="ss-box"><div style="font-size:15px;font-weight:600;margin-bottom:4px;">Pick your username</div>' +
        '<div class="ss-hint" style="margin-bottom:14px;">Friends find you by this. Lowercase letters, numbers, dots and underscores, 3 to 20 characters.</div>' +
        '<form id="ssSetupForm">' +
        '<div class="ss-field"><label for="ssUname">Username</label><input class="input" id="ssUname" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" value="' + esc(suggestUsername()) + '"><div class="ss-hint" id="ssUnameHint"></div></div>' +
        '<div class="ss-field"><label for="ssDname">Display name</label><input class="input" id="ssDname" maxlength="40" value="' + esc(dn) + '" placeholder="What friends see"></div>' +
        '<button class="btn btn-accent ss-btn-full" type="submit" style="margin-top:6px;">Continue</button></form>' +
        '<div class="ss-msg err" id="ssSetupMsg">' + esc(msg || '') + '</div>' +
        '<div style="margin-top:6px;"><button class="ss-link" data-act="signout">Sign out</button></div></div>');
    const u = $('ssUname');
    u.addEventListener('input', () => { u.value = u.value.toLowerCase().replace(/\s/g, ''); checkUsernameLive(u.value, $('ssUnameHint')); });
    if (u.value) checkUsernameLive(u.value, $('ssUnameHint'));
    $('ssSetupForm').addEventListener('submit', onSetupSubmit);
}

let unameTimer = null;
function checkUsernameLive(name, hintEl, currentName) {
    clearTimeout(unameTimer);
    if (!name) { hintEl.textContent = ''; return; }
    if (!USERNAME_RE.test(name)) { hintEl.style.color = 'var(--red)'; hintEl.textContent = '3 to 20 characters: a-z, 0-9, dot, underscore.'; return; }
    if (name === currentName) { hintEl.style.color = 'var(--text3)'; hintEl.textContent = 'This is your current username.'; return; }
    hintEl.style.color = 'var(--text3)'; hintEl.textContent = 'Checking…';
    unameTimer = setTimeout(async () => {
        try {
            const snap = await getDoc(doc(fs, 'usernames', name));
            if (snap.exists()) { hintEl.style.color = 'var(--red)'; hintEl.textContent = '@' + name + ' is taken.'; }
            else { hintEl.style.color = 'var(--accent)'; hintEl.textContent = '@' + name + ' is available.'; }
        } catch (e) { hintEl.textContent = ''; }
    }, 350);
}

async function onSetupSubmit(ev) {
    ev.preventDefault();
    const msg = $('ssSetupMsg');
    const btn = ev.target.querySelector('button[type=submit]');
    const name = $('ssUname').value.trim().toLowerCase();
    const dname = $('ssDname').value.trim().slice(0, 40) || name;
    if (!USERNAME_RE.test(name)) { msg.textContent = 'Username must be 3 to 20 characters: a-z, 0-9, dot, underscore.'; return; }
    btn.disabled = true; msg.textContent = '';
    try {
        const taken = await getDoc(doc(fs, 'usernames', name));
        if (taken.exists()) { msg.textContent = '@' + name + ' is taken. Try another.'; btn.disabled = false; return; }
        await claimProfile(S.user, name, dname);
        if (!S.user.displayName) { try { await updateProfile(S.user, { displayName: dname }); } catch (e) {} }
        toast('Welcome, @' + name);
    } catch (e) {
        console.warn(e);
        msg.textContent = e.code === 'permission-denied' ? 'That username could not be claimed (it may have just been taken, or is reserved). Try another.' : (e.message || 'Could not save.');
        btn.disabled = false;
    }
}

// Gate click handling (event delegation)
document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act],[data-mode],[data-slide]');
    if (!t || !gateEl() || !gateEl().contains(t)) return;
    if (t.dataset.slide) { S.slide = +t.dataset.slide; return renderSlides(); }
    if (t.dataset.mode) { S.authMode = t.dataset.mode; return renderAuth(); }
    const a = t.dataset.act;
    if (a === 'next') { S.slide = Math.min(S.slide + 1, SLIDES.length - 1); renderSlides(); }
    else if (a === 'prev') { S.slide = Math.max(S.slide - 1, 0); renderSlides(); }
    else if (a === 'skip' || a === 'finishSlides') finishSlides();
    else if (a === 'tour') { S.touring = true; S.slide = 0; renderSlides(); }
    else if (a === 'google') googleSignIn();
    else if (a === 'signout') { await signOut(auth); }
    else if (a === 'verified') {
        await S.user.reload();
        if (auth.currentUser.emailVerified) { await auth.currentUser.getIdToken(true); S.user = auth.currentUser; startUserListeners(); route(); }
        else renderVerify('Not verified yet. Click the link in the email first.');
    } else if (a === 'resend') {
        if (Date.now() < S.resendAt) return renderVerify('Please wait a minute before resending.');
        try { await sendEmailVerification(S.user, { url: location.origin + location.pathname }); S.resendAt = Date.now() + 60000; renderVerify('Sent again.', true); }
        catch (e) { renderVerify(authErr(e)); }
    }
});

// ═════════════════════════════════════════════
// AUTH STATE + LISTENERS
// ═════════════════════════════════════════════
function stopAllListeners() {
    const u = S.unsubs;
    ['profile', 'privacy', 'friendships'].forEach(k => { if (u[k]) { u[k](); u[k] = null; } });
    Object.values(u.friendProfiles).forEach(f => f()); u.friendProfiles = {};
    Object.values(u.friendStats).forEach(f => f()); u.friendStats = {};
    S.friendships = {}; S.profiles = {}; S.stats = {};
}

function startUserListeners() {
    stopAllListeners();
    const uid = S.user.uid;
    S.profile = undefined; S.profileErr = null;
    S.unsubs.profile = onSnapshot(doc(fs, 'profiles', uid), (snap) => {
        const had = !!S.profile;
        S.profile = snap.exists() ? snap.data() : null;
        S.profiles[uid] = S.profile;
        if (S.profile && !had) { startSocialListeners(); publishStats(true); }
        route();
    }, (err) => { S.profileErr = err.code || err.message; route(); });
}

function startSocialListeners() {
    const uid = S.user.uid;
    if (!S.unsubs.privacy) {
        S.unsubs.privacy = onSnapshot(doc(fs, 'privacy', uid), (snap) => {
            S.privacy = snap.exists() ? snap.data() : { mode: 'all', allow: [], block: [], showLive: true };
            renderFriends();
        }, () => {});
    }
    if (!S.unsubs.friendships) {
        S.unsubs.friendships = onSnapshot(query(collection(fs, 'friendships'), where('users', 'array-contains', uid)), (qs) => {
            const next = {};
            qs.forEach(d => { next[d.id] = d.data(); });
            S.friendships = next;
            syncFriendListeners();
            renderFriends();
            updateTabBadge();
        }, (err) => console.warn('friendships', err));
    }
}

function syncFriendListeners() {
    const want = {}, wantStats = {};
    Object.values(S.friendships).forEach(f => {
        const o = otherUid(f);
        want[o] = true;
        if (f.status === 'accepted') wantStats[o] = true;
    });
    const u = S.unsubs;
    Object.keys(u.friendProfiles).forEach(o => { if (!want[o]) { u.friendProfiles[o](); delete u.friendProfiles[o]; delete S.profiles[o]; } });
    Object.keys(u.friendStats).forEach(o => { if (!wantStats[o]) { u.friendStats[o](); delete u.friendStats[o]; delete S.stats[o]; } });
    Object.keys(want).forEach(o => {
        if (u.friendProfiles[o]) return;
        u.friendProfiles[o] = onSnapshot(doc(fs, 'profiles', o), (s) => { S.profiles[o] = s.exists() ? s.data() : { username: 'deleted', displayName: 'Deleted user' }; renderFriends(); }, () => {});
    });
    Object.keys(wantStats).forEach(o => { if (!u.friendStats[o]) listenStats(o); });
}

function listenStats(o) {
    S.unsubs.friendStats[o] = onSnapshot(doc(fs, 'stats', o), (s) => {
        S.stats[o] = s.exists() ? s.data() : null;
        renderFriends();
    }, () => {
        // permission denied = this friend is not sharing with you
        S.stats[o] = 'hidden';
        delete S.unsubs.friendStats[o];
        renderFriends();
    });
}
// Retry hidden friends now and then, in case they start sharing again
setInterval(() => {
    if (!S.user || !S.profile) return;
    Object.keys(S.stats).forEach(o => { if (S.stats[o] === 'hidden' && !S.unsubs.friendStats[o]) listenStats(o); });
}, 120000);

onAuthStateChanged(auth, (user) => {
    S.authReady = true;
    S.user = user;
    if (!user) {
        stopAllListeners(); S.profile = undefined; S.privacy = null; S.authMode = 'signin'; lastResults = [];
        const fp = $('panel-friends'); if (fp) { fp.innerHTML = ''; fp.dataset.built = ''; }
        const th = $('todayHero'); if (th) th.innerHTML = '';
        route(); return;
    }
    startUserListeners();
    route();
});

// ═════════════════════════════════════════════
// STATS PUBLISHING (your totals, for friends allowed to see them)
// ═════════════════════════════════════════════
function dayMins(d) { if (!d || !d.actual) return 0; return Object.values(d.actual).reduce((s, v) => s + (Number(v) || 0), 0); }
function computeStats() {
    const db = window._getDB ? window._getDB() : {};
    const tk = todayKey(), wk = mondayKey(), mk = monthKey();
    let week = 0, month = 0, total = 0;
    Object.keys(db).forEach(k => {
        const m = dayMins(db[k]);
        total += m;
        if (k >= wk && k <= tk) week += m;
        if (k.slice(0, 7) === mk) month += m;
    });
    const last7 = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = keyOf(d); last7.push({ d: k, m: Math.min(1440, Math.round(dayMins(db[k]))) }); }
    let streak = 0;
    try { streak = typeof window.getStreak === 'function' ? window.getStreak() : 0; } catch (e) {}
    const showLive = !S.privacy || S.privacy.showLive !== false;
    return {
        dayKey: tk, weekKey: wk, monthKey: mk,
        today: Math.min(1440, Math.round(dayMins(db[tk]))),
        week: Math.min(10080, Math.round(week)),
        month: Math.min(44640, Math.round(month)),
        total: Math.round(total),
        streak: Math.min(3650, streak || 0),
        last7: last7,
        liveSince: (showLive && S.liveSince) ? S.liveSince : null
    };
}
let statsTimer = null;
function publishStats(force) {
    if (!S.user || !S.profile) return;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(async () => {
        const st = computeStats();
        const json = JSON.stringify(st);
        if (!force && json === S.lastStatsJSON) return;
        S.lastStatsJSON = json;
        st.updatedAt = serverTimestamp();
        try { await setDoc(doc(fs, 'stats', S.user.uid), st); } catch (e) { console.warn('stats publish failed', e); }
        renderFriends();
    }, force ? 300 : 3000);
}
// Wrap the existing save hooks so stats stay current without touching the tracker code
(function wrapHooks() {
    const origSave = window._fireSave;
    if (origSave) window._fireSave = function (d) { origSave(d); publishStats(false); };
    const origSess = window._fireSessionState;
    if (origSess) window._fireSessionState = function (state) {
        origSess(state);
        S.liveSince = state && state.active ? (state.startedAt || Date.now()) : null;
        publishStats(true);
    };
})();
setInterval(() => { publishStats(false); }, 5 * 60000); // picks up midnight rollover

// ═════════════════════════════════════════════
// FRIENDS PANEL
// ═════════════════════════════════════════════
function incoming() { return Object.entries(S.friendships).filter(([, f]) => f.status === 'pending' && f.to === S.user.uid); }
function outgoing() { return Object.entries(S.friendships).filter(([, f]) => f.status === 'pending' && f.from === S.user.uid); }
function accepted() { return Object.entries(S.friendships).filter(([, f]) => f.status === 'accepted'); }

function updateTabBadge() {
    const tab = document.querySelector('.tab[data-tab="friends"]');
    if (!tab || !S.user) return;
    const n = incoming().length;
    tab.innerHTML = 'Friends' + (n ? '<span class="fr-count">' + n + '</span>' : '');
}

function canSeeMe(uid) {
    const p = S.privacy || { mode: 'all', allow: [], block: [] };
    if (p.mode === 'none') return false;
    if (p.mode === 'selected') return (p.allow || []).includes(uid);
    return !(p.block || []).includes(uid);
}

function statVal(st, range) {
    if (!st || st === 'hidden') return null;
    if (range === 'today') return st.dayKey === todayKey() ? st.today : 0;
    if (range === 'week') return st.weekKey === mondayKey() ? st.week : 0;
    if (range === 'month') return st.monthKey === monthKey() ? st.month : 0;
    if (range === 'streak') return st.streak || 0;
    return 0;
}
function liveMins(st) {
    if (!st || st === 'hidden' || !st.liveSince) return -1;
    const age = Date.now() - st.liveSince;
    if (age < 0 || age > 6 * 3600000) return -1;
    return age / 60000;
}
function liveTag(st) {
    const m = liveMins(st);
    return m < 0 ? '' : '<span class="tw-tag live">On track ' + fmtMins(m) + '</span>';
}

// Everyone on your grid (you + accepted friends), sorted for a range
function standings(range) {
    const uid = S.user.uid;
    const myStats = computeStats();
    const rows = [{ uid: uid, p: S.profile, st: myStats, me: true }];
    accepted().forEach(([, f]) => { const o = otherUid(f); rows.push({ uid: o, p: S.profiles[o], st: S.stats[o] }); });
    rows.forEach(x => { x.v = statVal(x.st, range); x.live = liveMins(x.me ? myStats : x.st) >= 0; });
    rows.sort((a, b) => (b.v == null ? -1 : b.v) - (a.v == null ? -1 : a.v));
    return { rows: rows, myStats: myStats };
}

function towerRow(x, pos, lead, range) {
    const hidden = x.v == null;
    const name = x.p ? (x.p.displayName || x.p.username) : '…';
    const fmt = (v) => range === 'streak' ? v + (v === 1 ? ' day' : ' days') : fmtMins(v);
    let right;
    if (hidden) right = '<span class="tw-tag priv">' + (x.st === undefined ? 'Loading' : 'Private') + '</span>';
    else right = '<b>' + fmt(x.v) + '</b>' + (pos === 1 ? '<small class="lead">Leader</small>' : '<small>+' + fmt(lead - x.v) + '</small>');
    return '<div class="tw-row' + (x.me ? ' me' : '') + (pos === 1 ? ' p1' : '') + (hidden ? ' hidden' : '') + '">' +
        '<div class="tw-pos">' + (hidden ? '-' : pos) + '</div>' +
        '<div class="tw-team" style="background:' + avatarColor(x.uid) + '"></div>' +
        '<div class="tw-name"><b>' + esc(name) + '</b>' + (x.me ? '<span class="tw-you">You</span>' : '') + (x.p ? flairHTML(x.p.flair) : '') + liveTag(x.me ? computeStats() : x.st) + '</div>' +
        '<div class="tw-time">' + right + '</div></div>';
}
function towerHTML(rows, range, max) {
    const vis = rows.filter(x => x.v != null);
    const lead = vis.length ? vis[0].v : 0;
    const out = [];
    let pos = 0, meShown = false;
    rows.forEach(x => {
        const p = x.v == null ? 0 : ++pos;
        if (!max || out.length < max) { out.push(towerRow(x, p, lead, range)); if (x.me) meShown = true; }
        else if (x.me && !meShown) { out.push(towerRow(x, p, lead, range)); meShown = true; }
    });
    return '<div class="tower">' + out.join('') + '</div>';
}

// ═════════ TODAY: driver card + grid quick view ═════════
// last 7 days as a strip of slanted bars (today highlighted)
function sparkHTML(last7) {
    const max = Math.max(60, ...last7.map(x => x.m));
    return '<div class="spark">' + last7.map((x, i) => {
        const d = new Date(x.d + 'T12:00:00');
        const h = Math.max(4, Math.round((x.m / max) * 100));
        return '<div class="spark-col' + (i === 6 ? ' now' : '') + '" title="' + esc(d.toDateString()) + ': ' + fmtMins(x.m) + '"><div class="spark-bar"><i style="height:' + h + '%"></i></div><span>' + d.toLocaleDateString('en-US', { weekday: 'narrow' }) + '</span></div>';
    }).join('') + '</div>';
}
function renderTodayHero() {
    const el = $('todayHero');
    if (!el || !S.user || !S.profile) return;
    const me = S.profile, uid = S.user.uid;
    const { rows, myStats } = standings('today');
    const vis = rows.filter(r => r.v != null);
    const myPos = vis.findIndex(r => r.me) + 1;
    const solo = vis.length <= 1;
    const liveCount = rows.filter(r => r.live && !r.me).length;
    const inc = incoming().length;
    const driver =
        '<div class="card driver" data-pos="' + (solo ? '' : 'P' + myPos) + '">' +
            '<div class="driver-badge" style="background:' + avatarColor(uid) + '">' + initial(me) + '</div>' +
            '<div style="min-width:0;"><div class="driver-name">' + esc(me.displayName || me.username) + ' ' + flairHTML(me.flair) + '</div>' +
            '<div class="driver-user">@' + esc(me.username) + ' ' + liveTag(myStats) + '</div></div>' +
            sparkHTML(myStats.last7) +
            '<div class="driver-stats">' +
                '<div class="driver-stat"><b>' + fmtMins(myStats.today) + '</b><span>Today</span></div>' +
                '<div class="driver-stat"><b>' + fmtMins(myStats.week) + '</b><span>This week</span></div>' +
                '<div class="driver-stat hl"><b>' + myStats.streak + 'd</b><span>Streak</span></div>' +
                '<div class="driver-stat"><b>' + (solo ? 'Solo' : 'P' + myPos + '<small style="font-size:15px;color:var(--text3)">/' + vis.length + '</small>') + '</b><span>Today\'s grid</span></div>' +
            '</div></div>';
    const grid =
        '<div class="card"><div class="card-title" style="justify-content:space-between;"><span>Today\'s grid</span>' +
            (liveCount ? '<span class="tw-tag live">' + liveCount + ' on track</span>' : '') + '</div>' +
            (accepted().length ? towerHTML(rows, 'today', 5)
                : '<div class="tw-note" style="padding:6px 0 4px;">Nobody on your grid yet. Add friends by username to race them for study hours.</div>') +
            '<div class="tw-more"><span class="tw-note">' + (inc ? inc + ' friend request' + (inc > 1 ? 's' : '') + ' waiting' : '') + '</span>' +
            '<button class="btn btn-ghost btn-sm" onclick="switchTab(\'friends\')">' + (accepted().length ? 'Full standings' : 'Find friends') + '</button></div>' +
        '</div>';
    el.innerHTML = driver + grid;
}
window._renderTodayHero = function () { renderTodayHero(); };
// keeps the "on track" minutes fresh without re-rendering anything else
setInterval(() => { const p = $('panel-today'); if (p && p.classList.contains('active')) renderTodayHero(); }, 60000);

// ═════════ FRIENDS PAGE ═════════
// Built once; later updates only touch the inner sections, so the search box
// is never replaced while someone is typing in it.
function ensureFriendsSkeleton(panel) {
    if (panel.dataset.built === '1') return;
    panel.innerHTML =
        '<div class="fr-grid">' +
        '<div class="card fr-full" id="frMe"></div>' +
        '<div class="card" id="frBoard"></div>' +
        '<div class="card" id="frChartCard"></div>' +
        '<div class="card"><div class="card-title">Find friends</div>' +
            '<form class="fr-search" id="frSearchForm" autocomplete="off"><input class="input" id="frSearch" placeholder="Search by username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="search"><button class="btn btn-accent btn-sm" type="submit">Search</button></form>' +
            '<div class="fr-list" id="frResults" style="margin-top:8px;"></div></div>' +
        '<div class="card" id="frReq"></div>' +
        '<div class="card fr-full" id="frList"></div>' +
        '</div>';
    panel.dataset.built = '1';
    const s = $('frSearch');
    s.addEventListener('input', () => runSearch(s.value, false));
    $('frSearchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(s.value, true); });
}

function renderFriends() {
    if (!S.user || !S.profile) return;
    renderTodayHero();
    updateTabBadge();
    const panel = $('panel-friends');
    if (!panel || !panel.classList.contains('active')) return;
    ensureFriendsSkeleton(panel);
    const me = S.profile, uid = S.user.uid;
    const priv = S.privacy || { mode: 'all' };
    const privLabel = { all: 'All friends can see your time', selected: 'Only friends you pick can see your time', none: 'Your time is hidden from everyone' }[priv.mode] || '';
    const r = S.lbRange;
    const { rows, myStats } = standings(r);

    $('frMe').innerHTML = '<div class="fr-me">' +
        '<div class="driver-badge" style="width:56px;height:56px;font-size:30px;background:' + avatarColor(uid) + '">' + initial(me) + '</div>' +
        '<div><div class="driver-name" style="font-size:26px;">' + esc(me.displayName || me.username) + ' ' + flairHTML(me.flair) + '</div><div class="driver-user">@' + esc(me.username) + '</div><div class="ss-hint" style="margin-top:4px;">' + esc(privLabel) + '</div></div>' +
        '<div class="fr-actions"><button class="btn btn-ghost btn-sm" data-fr="editProfile">Edit profile</button><button class="btn btn-ghost btn-sm" data-fr="privacy">Privacy</button><button class="btn btn-ghost btn-sm" data-fr="tour">Tour</button><button class="btn btn-ghost btn-sm" data-fr="signout">Sign out</button></div>' +
        '</div>';

    $('frBoard').innerHTML = '<div class="card-title" style="justify-content:space-between;flex-wrap:wrap;gap:8px;"><span>Standings</span><div class="fr-seg">' +
        ['today', 'week', 'month', 'streak'].map(k => '<button class="' + (r === k ? 'on' : '') + '" data-fr="range" data-r="' + k + '">' + { today: 'Today', week: 'Week', month: 'Month', streak: 'Streak' }[k] + '</button>').join('') +
        '</div></div>' + towerHTML(rows, r, 0) +
        (accepted().length ? '' : '<div class="tw-note" style="margin-top:10px;">Add friends to fill the grid.</div>');

    const visibleFriends = accepted().map(([, f]) => otherUid(f)).filter(o => S.stats[o] && S.stats[o] !== 'hidden');
    if (S.compareUid && !visibleFriends.includes(S.compareUid)) S.compareUid = null;
    if (!S.compareUid && visibleFriends.length) S.compareUid = visibleFriends[0];
    $('frChartCard').innerHTML = '<div class="card-title" style="justify-content:space-between;flex-wrap:wrap;gap:8px;"><span>Head to head · 7 days</span>' +
        (visibleFriends.length ? '<select class="input" id="frCompareSel" style="width:auto;font-size:12px;padding:4px 8px;">' + visibleFriends.map(o => '<option value="' + esc(o) + '"' + (o === S.compareUid ? ' selected' : '') + '>vs @' + esc(S.profiles[o] ? S.profiles[o].username : '…') + '</option>').join('') + '</select>' : '') +
        '</div>' + (visibleFriends.length ? '<div style="position:relative;height:210px;"><canvas id="frChart"></canvas></div>' : '<div class="tw-note">When a friend shares their time with you, you can compare the last 7 days here.</div>');
    const sel = $('frCompareSel');
    if (sel) sel.addEventListener('change', () => { S.compareUid = sel.value; drawCompareChart(myStats); });
    drawCompareChart(myStats);

    const inc = incoming().map(([id, f]) => { const o = f.from; return '<div class="fr-item">' + avatarHTML(S.profiles[o], o, true) + '<div class="fr-item-main">' + nameLine(S.profiles[o], o) + '</div><div class="fr-actions" style="margin-left:auto;width:auto;"><button class="btn btn-accent btn-sm" data-fr="accept" data-id="' + esc(id) + '">Accept</button><button class="btn btn-ghost btn-sm" data-fr="decline" data-id="' + esc(id) + '">Decline</button></div></div>'; }).join('');
    const out = outgoing().map(([id, f]) => { const o = f.to; return '<div class="fr-item">' + avatarHTML(S.profiles[o], o, true) + '<div class="fr-item-main">' + nameLine(S.profiles[o], o) + '</div><div class="fr-actions" style="margin-left:auto;width:auto;"><span class="fr-badge">Pending</span><button class="btn btn-ghost btn-sm" data-fr="cancel" data-id="' + esc(id) + '">Cancel</button></div></div>'; }).join('');
    $('frReq').innerHTML = '<div class="card-title">Requests' + (incoming().length ? '<span class="fr-count">' + incoming().length + '</span>' : '') + '</div>' +
        (inc || out ? '<div class="fr-list">' + inc + out + '</div>' : '<div class="tw-note">No pending requests.</div>');

    const fl = accepted().map(([id, f]) => {
        const o = otherUid(f);
        const sees = canSeeMe(o);
        const dis = priv.mode === 'none';
        const theirs = S.stats[o] === 'hidden' ? '<span class="fr-badge">Not sharing with you</span>' : '';
        return '<div class="fr-item">' + avatarHTML(S.profiles[o], o, true) + '<div class="fr-item-main">' + nameLine(S.profiles[o], o) + '</div>' +
            '<div class="fr-actions" style="margin-left:auto;width:auto;align-items:center;">' + theirs +
            '<label class="sw-wrap" title="' + (dis ? 'Your privacy is set to No one' : 'Let this friend see your study time') + '">Sees my time <span class="sw"><input type="checkbox" data-fr="toggle" data-uid="' + esc(o) + '"' + (sees ? ' checked' : '') + (dis ? ' disabled' : '') + '><span></span></span></label>' +
            '<button class="btn btn-ghost btn-sm" data-fr="remove" data-id="' + esc(id) + '" data-name="' + esc(S.profiles[o] ? S.profiles[o].username : '') + '">Remove</button></div></div>';
    }).join('');
    $('frList').innerHTML = '<div class="card-title">Friends (' + accepted().length + ')</div>' +
        (fl ? '<div class="fr-list">' + fl + '</div>' : '<div class="tw-note">No friends yet. Search for a username above.</div>');

    if (lastResults.length) renderSearchResults(); // refresh Add / Requested states
}

let compareChart = null;
function drawCompareChart(myStats) {
    const cv = $('frChart');
    if (compareChart) { compareChart.destroy(); compareChart = null; }
    if (!cv || !S.compareUid || typeof Chart === 'undefined') return;
    const them = S.stats[S.compareUid];
    if (!them || them === 'hidden') return;
    const theirMap = {}; (them.last7 || []).forEach(x => { theirMap[x.d] = x.m; });
    const labels = myStats.last7.map(x => new Date(x.d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase());
    const css = getComputedStyle(document.documentElement);
    const myCol = (css.getPropertyValue('--accent') || '#00c49a').trim();
    const p = S.profiles[S.compareUid];
    const font = { family: "'Barlow Condensed', sans-serif", size: 13, weight: '600' };
    compareChart = new Chart(cv.getContext('2d'), {
        type: 'bar',
        data: { labels: labels, datasets: [
            { label: 'YOU', data: myStats.last7.map(x => +(x.m / 60).toFixed(2)), backgroundColor: myCol, borderRadius: 0, barPercentage: .8, categoryPercentage: .7 },
            { label: '@' + (p ? p.username : '').toUpperCase(), data: myStats.last7.map(x => +((theirMap[x.d] || 0) / 60).toFixed(2)), backgroundColor: '#f2f1ec', borderRadius: 0, barPercentage: .8, categoryPercentage: .7 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { labels: { color: '#b9bcc4', font: font, boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + fmtMins(c.raw * 60) } } },
            scales: { x: { ticks: { color: '#737885', font: font }, grid: { display: false } }, y: { ticks: { color: '#737885', font: font, callback: (v) => v + 'h' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true } } }
    });
}

// ── search ──
let searchTimer = null, lastResults = [], searchSeq = 0;
function runSearch(v, now) {
    clearTimeout(searchTimer);
    const q = (v || '').trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
    if (q.length < 2) { searchSeq++; lastResults = []; renderSearchResults(q.length ? 'Type at least 2 characters.' : ''); return; }
    const seq = ++searchSeq;
    renderSearchResults('Searching…');
    searchTimer = setTimeout(async () => {
        try {
            const [qs, exact] = await Promise.all([
                getDocs(query(collection(fs, 'profiles'), orderBy('username'), startAt(q), endAt(q + ''), limit(10))),
                getDoc(doc(fs, 'usernames', q)).catch(() => null)
            ]);
            if (seq !== searchSeq) return; // a newer search is running
            const found = new Map();
            qs.forEach(d => { if (d.id !== S.user.uid) found.set(d.id, d.data()); });
            if (exact && exact.exists()) {
                const xu = exact.data().uid;
                if (xu !== S.user.uid && !found.has(xu)) { const ps = await getDoc(doc(fs, 'profiles', xu)); if (ps.exists()) found.set(xu, ps.data()); }
            }
            lastResults = Array.from(found, ([uid, p]) => ({ uid: uid, p: p }));
            renderSearchResults(lastResults.length ? '' : 'Nobody with a username starting with "' + q + '".');
        } catch (e) {
            console.warn('search failed', e);
            if (seq === searchSeq) renderSearchResults('Search failed (' + (e.code || e.message) + '). Check your connection and try again.');
        }
    }, now ? 0 : 350);
}
function renderSearchResults(msg) {
    const el = $('frResults');
    if (!el) return;
    if (msg) { el.innerHTML = '<div class="tw-note" style="padding:6px 0;">' + esc(msg) + '</div>'; return; }
    if (msg === '') { el.innerHTML = ''; if (!lastResults.length) return; }
    el.innerHTML = lastResults.map(x => {
        const f = S.friendships[pairId(S.user.uid, x.uid)];
        let act;
        if (!f) act = '<button class="btn btn-accent btn-sm" data-fr="add" data-uid="' + esc(x.uid) + '">Add</button>';
        else if (f.status === 'accepted') act = '<span class="fr-badge">Friends</span>';
        else if (f.from === S.user.uid) act = '<span class="fr-badge">Requested</span>';
        else act = '<button class="btn btn-accent btn-sm" data-fr="accept" data-id="' + esc(pairId(S.user.uid, x.uid)) + '">Accept</button>';
        return '<div class="fr-item">' + avatarHTML(x.p, x.uid, true) + '<div class="fr-item-main">' + nameLine(x.p, x.uid) + '</div><div style="margin-left:auto;">' + act + '</div></div>';
    }).join('');
}

// ── friend actions ──
async function sendRequest(o) {
    const me = S.user.uid;
    const id = pairId(me, o);
    try {
        await setDoc(doc(fs, 'friendships', id), { users: [me, o], from: me, to: o, status: 'pending', createdAt: serverTimestamp() });
        toast('Friend request sent');
    } catch (e) {
        // If they already sent us one, accept it instead
        try {
            const s = await getDoc(doc(fs, 'friendships', id));
            if (s.exists() && s.data().to === me && s.data().status === 'pending') return acceptRequest(id);
        } catch (e2) {}
        toast('Could not send request');
        console.warn(e);
    }
}
async function acceptRequest(id) {
    try { await updateDoc(doc(fs, 'friendships', id), { status: 'accepted', acceptedAt: serverTimestamp() }); toast('Friend added'); }
    catch (e) { toast('Could not accept'); console.warn(e); }
}
async function removeFriendship(id, msg) {
    try { await deleteDoc(doc(fs, 'friendships', id)); if (msg) toast(msg); }
    catch (e) { toast('Could not update'); console.warn(e); }
}
async function savePrivacy(next) {
    const p = Object.assign({ mode: 'all', allow: [], block: [], showLive: true }, S.privacy || {}, next);
    p.allow = Array.from(new Set(p.allow)).slice(0, 500);
    p.block = Array.from(new Set(p.block)).slice(0, 500);
    try { await setDoc(doc(fs, 'privacy', S.user.uid), { mode: p.mode, allow: p.allow, block: p.block, showLive: !!p.showLive }); S.privacy = p; publishStats(true); }
    catch (e) { toast('Could not save privacy'); console.warn(e); }
}
async function toggleSees(o, on) {
    const p = S.privacy || { mode: 'all', allow: [], block: [] };
    if (p.mode === 'selected') {
        const allow = (p.allow || []).filter(x => x !== o); if (on) allow.push(o);
        await savePrivacy({ allow: allow });
    } else if (p.mode === 'all') {
        const block = (p.block || []).filter(x => x !== o); if (!on) block.push(o);
        await savePrivacy({ block: block });
    }
    toast(on ? 'They can now see your time' : 'Your time is now hidden from them');
}

document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-fr]');
    if (!t || t.tagName === 'INPUT') return;
    const a = t.dataset.fr;
    if (a === 'range') { S.lbRange = t.dataset.r; renderFriends(); }
    else if (a === 'add') { t.disabled = true; await sendRequest(t.dataset.uid); }
    else if (a === 'accept') { t.disabled = true; await acceptRequest(t.dataset.id); }
    else if (a === 'decline') { await removeFriendship(t.dataset.id, 'Request declined'); }
    else if (a === 'cancel') { await removeFriendship(t.dataset.id, 'Request cancelled'); }
    else if (a === 'remove') { if (confirm('Remove @' + t.dataset.name + ' from your friends?')) await removeFriendship(t.dataset.id, 'Friend removed'); }
    else if (a === 'editProfile') openProfileModal();
    else if (a === 'privacy') openPrivacyModal();
    else if (a === 'tour') { S.touring = true; S.slide = 0; renderSlides(); }
    else if (a === 'signout') { if (confirm('Sign out of Study Savvy?')) await signOut(auth); }
});
document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.fr === 'toggle') toggleSees(t.dataset.uid, t.checked);
});

// ═════════════════════════════════════════════
// MODALS: edit profile, privacy
// ═════════════════════════════════════════════
function modal(html) {
    let m = $('ssModal');
    if (!m) { m = document.createElement('div'); m.id = 'ssModal'; m.className = 'ss-modal'; document.body.appendChild(m); m.addEventListener('click', (e) => { if (e.target === m) closeModal(); }); }
    m.innerHTML = '<div class="ss-modal-box">' + html + '</div>';
    m.hidden = false;
    return m;
}
function closeModal() { const m = $('ssModal'); if (m) m.hidden = true; }
window._ssCloseModal = closeModal;

function openProfileModal() {
    const p = S.profile;
    let color = (p.flair && p.flair.color) || 'grey';
    const sw = Object.entries(PALETTE).map(([k, c]) => '<button type="button" class="swatch' + (k === color ? ' on' : '') + '" data-c="' + k + '" title="' + c.name + '" style="background:' + c.bg + '"></button>').join('') +
        (isAuthor() ? '<button type="button" class="swatch' + (color === 'f1' ? ' on' : '') + '" data-c="f1" title="F1 (author only)" style="background:linear-gradient(135deg,#0b1f4d 50%,#ff6a00 50%)"></button>' : '');
    const m = modal('<div class="ss-modal-title">Edit profile <button class="ss-link" onclick="window._ssCloseModal()">Close</button></div>' +
        '<div class="ss-preview" id="pfPreview"></div>' +
        '<div class="ss-field"><label>Display name</label><input class="input" id="pfName" maxlength="40" value="' + esc(p.displayName || '') + '"></div>' +
        '<div class="ss-field"><label>Username</label><input class="input" id="pfUser" maxlength="20" autocapitalize="none" spellcheck="false" value="' + esc(p.username) + '"><div class="ss-hint" id="pfUserHint">' + (loginNameOf(S.user) ? 'You will still sign in with ' + esc(loginNameOf(S.user)) + '.' : '') + '</div></div>' +
        '<div class="ss-field"><label>Flair text</label><input class="input" id="pfFlair" maxlength="24" placeholder="e.g. ECE 2T9, grinding, coffee first" value="' + esc(p.flair && p.flair.color !== 'f1' ? p.flair.text : '') + '"><div class="ss-hint">Up to 24 characters. Leave blank for no flair.</div></div>' +
        '<div class="ss-field"><label>Flair colour</label><div class="swatches" id="pfSw">' + sw + '</div>' + (isAuthor() ? '<div class="ss-hint">The F1 swatch is your author flair. Nobody else can pick it.</div>' : '') + '</div>' +
        '<div class="ss-msg err" id="pfMsg"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;"><button class="btn btn-ghost btn-sm" onclick="window._ssCloseModal()">Cancel</button><button class="btn btn-accent btn-sm" id="pfSave">Save</button></div>');
    const preview = () => {
        const f = color === 'f1' ? { text: 'simply lovely', color: 'f1' } : { text: $('pfFlair').value.trim(), color: color };
        $('pfPreview').innerHTML = avatarHTML(p, S.user.uid, true) + '<div class="fr-name">' + esc($('pfName').value.trim() || p.username) + ' ' + flairHTML(f) + '</div>';
        $('pfFlair').disabled = color === 'f1';
    };
    m.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => { color = b.dataset.c; m.querySelectorAll('.swatch').forEach(x => x.classList.toggle('on', x === b)); preview(); }));
    $('pfName').addEventListener('input', preview);
    $('pfFlair').addEventListener('input', preview);
    const u = $('pfUser');
    u.addEventListener('input', () => { u.value = u.value.toLowerCase().replace(/\s/g, ''); checkUsernameLive(u.value, $('pfUserHint'), p.username); });
    preview();
    $('pfSave').addEventListener('click', async () => {
        const msg = $('pfMsg'), btn = $('pfSave');
        const name = u.value.trim().toLowerCase();
        const dname = $('pfName').value.trim().slice(0, 40) || name;
        const ftext = $('pfFlair').value.trim().slice(0, 24);
        const flair = color === 'f1' ? { text: 'simply lovely', color: 'f1' } : { text: ftext, color: color };
        if (!USERNAME_RE.test(name)) { msg.textContent = 'Username must be 3 to 20 characters: a-z, 0-9, dot, underscore.'; return; }
        if (color !== 'f1' && ftext.toLowerCase() === 'simply lovely' && !isAuthor()) { msg.textContent = 'That flair is reserved.'; return; }
        btn.disabled = true; msg.textContent = '';
        try {
            const uid = S.user.uid;
            if (name !== p.username) {
                const taken = await getDoc(doc(fs, 'usernames', name));
                if (taken.exists()) { msg.textContent = '@' + name + ' is taken.'; btn.disabled = false; return; }
                const b = writeBatch(fs);
                b.set(doc(fs, 'usernames', name), { uid: uid });
                b.update(doc(fs, 'profiles', uid), { username: name, displayName: dname, flair: flair, updatedAt: serverTimestamp() });
                b.delete(doc(fs, 'usernames', p.username));
                await b.commit();
            } else {
                await updateDoc(doc(fs, 'profiles', uid), { displayName: dname, flair: flair, updatedAt: serverTimestamp() });
            }
            closeModal(); toast('Profile saved');
        } catch (e) {
            console.warn(e);
            msg.textContent = e.code === 'permission-denied' ? 'Not allowed. That username or flair may be reserved.' : (e.message || 'Could not save.');
            btn.disabled = false;
        }
    });
}

function openPrivacyModal() {
    const p = S.privacy || { mode: 'all', showLive: true };
    let mode = p.mode;
    const opt = (k, title, sub) => '<label class="radio-opt' + (mode === k ? ' on' : '') + '"><input type="radio" name="pvMode" value="' + k + '"' + (mode === k ? ' checked' : '') + '><div><b>' + title + '</b><small>' + sub + '</small></div></label>';
    const m = modal('<div class="ss-modal-title">Who can see your study time <button class="ss-link" onclick="window._ssCloseModal()">Close</button></div>' +
        opt('all', 'All friends', 'Every friend sees your totals, except the ones you switch off in your friends list.') +
        opt('selected', 'Only friends I pick', 'Nobody sees your totals until you switch them on in your friends list.') +
        opt('none', 'No one', 'Your totals are hidden from every friend. You can still see friends who share with you.') +
        '<label class="sw-wrap" style="margin:8px 0 4px;font-size:12px;color:var(--text2);"><span class="sw"><input type="checkbox" id="pvLive"' + (p.showLive !== false ? ' checked' : '') + '><span></span></span> Show friends when I am studying right now</label>' +
        '<div class="ss-hint">Friends who can see your time only ever see totals (today, week, month, streak, last 7 days). Your sessions, notes, categories and activity log stay private.</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;"><button class="btn btn-ghost btn-sm" onclick="window._ssCloseModal()">Cancel</button><button class="btn btn-accent btn-sm" id="pvSave">Save</button></div>');
    m.querySelectorAll('input[name=pvMode]').forEach(r => r.addEventListener('change', () => { mode = r.value; m.querySelectorAll('.radio-opt').forEach(o => o.classList.toggle('on', o.querySelector('input').checked)); }));
    $('pvSave').addEventListener('click', async () => {
        await savePrivacy({ mode: mode, showLive: $('pvLive').checked });
        closeModal(); toast('Privacy saved');
    });
}

// ═════════ APPEARANCE (per device, saved in this browser) ═════════
const AP_KEY = 'ss_appearance_v1';
const BGS = {
    carbon:  { name: 'Carbon',  css: 'repeating-linear-gradient(45deg,#1a1c21 0 2px,#0b0c0f 2px 7px)' },
    checker: { name: 'Checker', css: 'repeating-conic-gradient(#1d1f24 0 25%,#0b0c0f 0 50%) 0 0/16px 16px' },
    track:   { name: 'Track',   css: 'linear-gradient(115deg,#0b0c0f 55%,#1d3b33 55% 62%,#0b0c0f 62% 65%,#16302a 65% 68%,#0b0c0f 68%)' },
    grid:    { name: 'Grid',    css: 'linear-gradient(#1c1e23 1px,transparent 1px) 0 0/12px 12px,linear-gradient(90deg,#1c1e23 1px,#0b0c0f 1px) 0 0/12px 12px' },
    aurora:  { name: 'Aurora',  css: 'radial-gradient(circle at 20% 20%,#1f4a40,transparent 60%),radial-gradient(circle at 90% 60%,#2e2350,#0b0c0f 70%)' },
    campus:  { name: 'Front Campus', css: "url('campus-thumb.webp') center/cover" },
    plain:   { name: 'Plain',   css: '#0b0c0f' }
};
const GLASS = { off: 'Solid', lite: 'Glass', full: 'Frosted glass' };
function loadAp() { try { return Object.assign({ bg: 'carbon', glass: 'off' }, JSON.parse(localStorage.getItem(AP_KEY) || '{}')); } catch (e) { return { bg: 'carbon', glass: 'off' }; } }
function applyAp(a) { document.documentElement.dataset.bg = a.bg; document.documentElement.dataset.glass = a.glass; }
function saveAp(a) { try { localStorage.setItem(AP_KEY, JSON.stringify(a)); } catch (e) {} applyAp(a); renderApCard(); }
function renderApCard() {
    const panel = $('panel-export'); if (!panel) return;
    let card = $('apCard');
    if (!card) { card = document.createElement('div'); card.className = 'card export-card'; card.id = 'apCard'; panel.insertBefore(card, panel.firstChild); }
    const a = loadAp();
    card.innerHTML = '<div class="export-title">Appearance</div><div class="export-desc">Saved on this device only. Frosted glass looks best but uses the most battery and CPU.</div>' +
        '<div class="section-label" style="margin-bottom:8px;">Background</div><div class="ap-grid">' +
        Object.entries(BGS).map(([k, v]) => '<button class="ap-opt' + (a.bg === k ? ' on' : '') + '" data-ap-bg="' + k + '" style="background:' + v.css + '">' + v.name + '</button>').join('') + '</div>' +
        '<div class="section-label" style="margin-bottom:8px;">Panels</div><div class="seg">' +
        Object.entries(GLASS).map(([k, v]) => '<button class="' + (a.glass === k ? 'on' : '') + '" data-ap-glass="' + k + '">' + v + '</button>').join('') + '</div>';
}
document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-ap-bg],[data-ap-glass]'); if (!t) return;
    const a = loadAp();
    if (t.dataset.apBg) a.bg = t.dataset.apBg; else a.glass = t.dataset.apGlass;
    saveAp(a);
});
applyAp(loadAp());
renderApCard();

// Called by switchTab('friends') in index.html
window._renderFriends = function () { renderFriends(); };

route();
