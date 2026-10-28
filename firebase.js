// Firebase setup + cloud sync (moved out of index.html)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyD5w3MVOM0V5S_hkPZwxtEkN1VZ-HWYSKA",
    authDomain: "study-savvy-fr.firebaseapp.com",
    projectId: "study-savvy-fr",
    storageBucket: "study-savvy-fr.firebasestorage.app",
    messagingSenderId: "866981620017",
    appId: "1:866981620017:web:a71962391d05b05c2b2810"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db_fire = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
let firestoreUnsub = null;
let logUnsub = null;
let syncTimeout = null;

// Expose to global scope so non-module scripts can call them
window._fireSignIn = async function() {
    try {
        await signInWithPopup(auth, provider);
    } catch(e) {
        window.notify('Sign-in failed: ' + e.message);
    }
};
window._fireSignOut = async function() {
    await signOut(auth);
};

// Save study db to Firestore (debounced 2s)
window._fireSave = function(dbData) {
    if (!currentUser) return;
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async function() {
        try {
            await setDoc(doc(db_fire, 'users', currentUser.uid), { data: JSON.stringify(dbData) });
        } catch(e) {
            console.warn('Firestore save failed:', e);
        }
    }, 2000);
};

// Save activity log to Firestore immediately
window._fireLogSave = async function(logData) {
    if (!currentUser) return;
    try {
        await setDoc(doc(db_fire, 'logs', currentUser.uid), logData);
    } catch(e) {
        console.warn('Firestore log save failed:', e);
    }
};

// Save active session state to Firestore
window._fireSessionState = async function(state) {
    if (!currentUser) return;
    try {
        await setDoc(doc(db_fire, 'sessions', currentUser.uid), state);
    } catch(e) {
        console.warn('Firestore session state save failed:', e);
    }
};

onAuthStateChanged(auth, function(user) {
    currentUser = user;

    // Clean up old listeners
    if (firestoreUnsub) { firestoreUnsub(); firestoreUnsub = null; }
    if (logUnsub) { logUnsub(); logUnsub = null; }

    if (user) {
        // Shared-device safety: if this browser's local data belongs to a different account,
        // wipe it before syncing so one person's data never merges into another's account.
        var _ownerKey = 'ss_owner_uid';
        var _prevOwner = localStorage.getItem(_ownerKey);
        if (_prevOwner && _prevOwner !== user.uid) {
            ['studyTracker_v3','studyLog_v1','studyCategories_v2','studyCatLabels_v1'].forEach(function(k){ localStorage.removeItem(k); });
            localStorage.setItem(_ownerKey, user.uid);
            location.reload();
            return;
        }
        localStorage.setItem(_ownerKey, user.uid);

        // Update header UI
        document.getElementById('authBtn').textContent = 'Sign Out';
        document.getElementById('authBtn').onclick = window._fireSignOut;
        document.getElementById('authUser').textContent = user.displayName || user.email;
        document.getElementById('authUser').style.display = 'block';
        document.getElementById('syncStatus').textContent = 'Syncing...';
        document.getElementById('syncStatus').style.display = 'block';
        // Update export tab account card
        document.getElementById('accountSignedOut').style.display = 'none';
        document.getElementById('accountSignedIn').style.display = 'block';
        document.getElementById('accountName').textContent = user.displayName || 'Signed in';
        document.getElementById('accountEmail').textContent = user.email;
        document.getElementById('accountSyncStatus').textContent = 'Syncing...';

        // Push any locally accumulated log entries up immediately on sign-in
        if (window._getActivityLog) {
            var localLog = window._getActivityLog();
            if (localLog.entries.length > 0) {
                window._fireLogSave(localLog);
            }
        }

        // ── Listen: activity log ──
        logUnsub = onSnapshot(doc(db_fire, 'logs', user.uid), function(snap) {
            if (!window._mergeActivityLog) return;
            if (snap.exists()) {
                window._mergeActivityLog(snap.data());
            }
        });

        // ── Listen: active session on other device ──
        onSnapshot(doc(db_fire, 'sessions', user.uid), function(snap) {
            if (!snap.exists()) return;
            var s = snap.data();
            var banner = document.getElementById('activeSessionBanner');
            var bannerText = document.getElementById('activeSessionBannerText');
            if (!banner || !bannerText) return;
            // Only show if started recently (within 3 hours) and this device isn't running
            var age = Date.now() - (s.startedAt || 0);
            if (s.active && age < 3 * 60 * 60 * 1000 && !window._isRunning()) {
                var cat = (window._getCats ? window._getCats() : []).find(function(c){ return c.id === s.cat; });
                var mins = Math.round(age / 60000);
                bannerText.textContent = 'Session active on another device — ' + (cat ? cat.label : s.cat) + ', started ' + mins + ' min ago.';
                banner.style.display = 'flex';
            } else {
                banner.style.display = 'none';
            }
        });

        // ── Listen: study db ──
        firestoreUnsub = onSnapshot(doc(db_fire, 'users', user.uid), function(snap) {
            if (snap.exists()) {
                try {
                    var cloudData = JSON.parse(snap.data().data || '{}');
                    var local = window._getDB ? window._getDB() : {};
                    var merged = Object.assign({}, cloudData);
                    Object.keys(local).forEach(function(k) {
                        if (!merged[k]) {
                            merged[k] = local[k];
                        } else {
                            var localMins = ['dayStudy','eveningStudy','career'].reduce(function(s,c){ return s+((local[k].actual&&local[k].actual[c])||0); }, 0);
                            var cloudMins = ['dayStudy','eveningStudy','career'].reduce(function(s,c){ return s+((merged[k].actual&&merged[k].actual[c])||0); }, 0);
                            if (localMins > cloudMins) merged[k] = local[k];
                        }
                    });
                    if (window._setDB) window._setDB(merged);
                    if (window._fireSave) window._fireSave(merged);
                    document.getElementById('syncStatus').textContent = 'Synced';
                    document.getElementById('accountSyncStatus').textContent = 'Synced';
                    setTimeout(function(){ document.getElementById('syncStatus').textContent = ''; document.getElementById('syncStatus').style.display='none'; document.getElementById('accountSyncStatus').textContent = 'All data synced'; }, 2000);
                } catch(e) {
                    console.warn('Firestore parse error:', e);
                }
            } else {
                if (window._getDB) window._fireSave(window._getDB());
                document.getElementById('syncStatus').textContent = 'Synced';
                document.getElementById('accountSyncStatus').textContent = 'Synced';
                setTimeout(function(){ document.getElementById('syncStatus').textContent = ''; document.getElementById('syncStatus').style.display='none'; document.getElementById('accountSyncStatus').textContent = 'All data synced'; }, 2000);
            }
        });
    } else {
        // Signed out
        document.getElementById('authBtn').textContent = 'Sign in with Google';
        document.getElementById('authBtn').onclick = window._fireSignIn;
        document.getElementById('authUser').style.display = 'none';
        document.getElementById('syncStatus').style.display = 'none';
        document.getElementById('accountSignedOut').style.display = 'block';
        document.getElementById('accountSignedIn').style.display = 'none';
        var banner = document.getElementById('activeSessionBanner');
        if (banner) banner.style.display = 'none';
    }
});
