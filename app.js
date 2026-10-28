// Study Savvy app logic (moved out of index.html)
// ── SERVICE WORKER ──
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('sw.js').then(function(reg) {
            // Force check for SW update on every load — no waiting 24hrs
            reg.update();
            // When a new SW is found and activated, reload all clients automatically
            reg.addEventListener('updatefound', function() {
                var newWorker = reg.installing;
                newWorker.addEventListener('statechange', function() {
                    if (newWorker.state === 'activated') {
                        // New SW took over — reload to get fresh files
                        window.location.reload();
                    }
                });
            });
        }).catch(function(err) {
            console.warn('SW registration failed:', err);
        });
    });
}

// ── PWA INSTALL PROMPT ──
var deferredPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('installBanner').style.display = 'flex';
});
window.addEventListener('appinstalled', function() {
    document.getElementById('installBanner').style.display = 'none';
    deferredPrompt = null;
    notify('Study Savvy installed!');
});
function installPWA() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function() {
        deferredPrompt = null;
        document.getElementById('installBanner').style.display = 'none';
    });
}
function dismissInstall() {
    document.getElementById('installBanner').style.display = 'none';
}

/* ── DYNAMIC CATEGORY SYSTEM ──
   Categories used to be a fixed set of 3 (dayStudy/eveningStudy/career) with only
   the label editable. This has been replaced with fully editable categories: you can
   add/delete categories, recolor them, rename them, and give each one its own
   auto-switch schedule per day of the week (or mark it "Anytime" for manual-only). */
const CATS_DEFAULT = [
    { id: 'dayStudy',     label: 'Day Study',     hours: '9AM-6PM',  color: '#00c49a', activeClass: 'active-day' },
    { id: 'eveningStudy', label: 'Evening Study',  hours: '6PM-12AM', color: '#d63384', activeClass: 'active-evening' },
    { id: 'career',       label: 'Career Work',    hours: 'Anytime',  color: '#d4a017', activeClass: 'active-career' }
];
const CAT_LABELS_KEY = 'studyCatLabels_v1'; // old label-only storage, kept for migration
const CATEGORIES_KEY = 'studyCategories_v2'; // new full category storage (label, color, schedule)

function buildSchedule(start, end, enabledDays) {
    var sch = {};
    for (var d = 0; d < 7; d++) {
        sch[d] = { enabled: enabledDays.indexOf(d) >= 0, start: start, end: end };
    }
    return sch;
}

// Default daily goal (minutes) per day of week — used to auto-fill aims when a new day starts
function buildGoalSchedule(hours) {
    var mins = Math.round((hours || 0) * 60);
    var g = {};
    for (var d = 0; d < 7; d++) { g[d] = mins; }
    return g;
}

function defaultCategories() {
    return [
        { id: 'dayStudy',     label: 'Day Study',     color: '#00c49a', anytime: false, schedule: buildSchedule('09:00','18:00',[0,1,2,3,4,5,6]), defaultGoal: buildGoalSchedule(0) },
        { id: 'eveningStudy', label: 'Evening Study', color: '#d63384', anytime: false, schedule: buildSchedule('18:00','23:59',[0,1,2,3,4,5,6]), defaultGoal: buildGoalSchedule(0) },
        { id: 'career',       label: 'Career Work',   color: '#d4a017', anytime: true,  schedule: buildSchedule('09:00','18:00',[]), defaultGoal: buildGoalSchedule(0) }
    ];
}

function loadCategories() {
    try {
        var saved = JSON.parse(localStorage.getItem(CATEGORIES_KEY));
        if (saved && Array.isArray(saved) && saved.length) {
            // Backfill in case a category is missing fields from an older save
            saved.forEach(function(c) {
                if (!c.schedule) c.schedule = buildSchedule('09:00','18:00',[]);
                for (var d = 0; d < 7; d++) { if (!c.schedule[d]) c.schedule[d] = { enabled:false, start:'09:00', end:'18:00' }; }
                if (typeof c.anytime !== 'boolean') c.anytime = false;
                if (!c.color) c.color = '#00c49a';
                if (!c.defaultGoal) c.defaultGoal = buildGoalSchedule(0);
                for (var g = 0; g < 7; g++) { if (typeof c.defaultGoal[g] !== 'number') c.defaultGoal[g] = 0; }
            });
            return saved;
        }
    } catch(e) {}
    // Migrate from the old label-only key if present, otherwise use defaults
    var cats = defaultCategories();
    try {
        var oldLabels = JSON.parse(localStorage.getItem(CAT_LABELS_KEY) || '{}');
        cats.forEach(function(c) { if (oldLabels[c.id]) c.label = oldLabels[c.id]; });
    } catch(e) {}
    return cats;
}

function saveCategories() {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(CATS));
    if (window._fireSave) window._fireSave(db);
}

const CATS = loadCategories();
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DB_KEY = 'studyTracker_v3';
let db = {}, currentMode = 'stopwatch', currentCat = getAutoCat(), running = false,
    interval = null, startTime = null, elapsedMs = 0, sessionStart = null,
    countdownTotal = 0, aimOpen = true, compareDay = new Date().getDay(), charts = {};

function loadDB(){ try { db = JSON.parse(localStorage.getItem(DB_KEY)||'{}'); } catch(e){ db={}; } }
function saveDB(){
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    if (window._fireSave) window._fireSave(db);
}
function _getDB(){ return db; }
function _setDB(newDb){
    db = newDb;
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    loadAims(); renderProgress(); updateStreak(); buildDaySelector(); renderSummary();
}
window._getDB = _getDB;
window._setDB = _setDB;
window._isRunning = function() { return running; };
window._getCats = function() { return CATS; };
function getTodayKey(){ const d=new Date(); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function getOrCreate(k){
    if(!db[k]){
        var aims={}, actual={};
        var dow=new Date(k+'T12:00:00').getDay();
        CATS.forEach(function(c){ aims[c.id]=(c.defaultGoal&&c.defaultGoal[dow])||0; actual[c.id]=0; });
        db[k]={aims:aims,actual:actual,sessions:[]};
    }
    return db[k];
}
function pad2(n){ return String(n).padStart(2,'0'); }
function formatMs(ms){ if(ms<0)ms=0; var t=Math.floor(ms/1000); return pad2(Math.floor(t/3600))+':'+pad2(Math.floor((t%3600)/60))+':'+pad2(t%60); }
function minsToHours(m){ if(!m)return'0h'; var h=Math.floor(m/60),r=Math.round(m%60); if(h===0)return r+'m'; if(r===0)return h+'h'; return h+'h '+r+'m'; }
function minsToDecimal(m){ return (m/60).toFixed(1); }
function hoursToMins(v){ var n=parseFloat(v); return(isNaN(n)||n<0)?0:Math.round(n*60); }
function timeToMins(hhmm){ var p=hhmm.split(':'); return (parseInt(p[0],10)||0)*60+(parseInt(p[1],10)||0); }
function getAutoCat(){
    var now=new Date(); var day=now.getDay(); var mins=now.getHours()*60+now.getMinutes();
    for(var i=0;i<CATS.length;i++){
        var c=CATS[i];
        if(c.anytime) continue;
        var sch=c.schedule && c.schedule[day];
        if(!sch || !sch.enabled) continue;
        var s=timeToMins(sch.start), e=timeToMins(sch.end);
        if(s<=e){ if(mins>=s&&mins<=e) return c.id; }
        else { if(mins>=s||mins<=e) return c.id; } // overnight range (e.g. 22:00 to 06:00)
    }
    var anytimeCat=CATS.find(function(c){ return c.anytime; });
    if(anytimeCat) return anytimeCat.id;
    return CATS[0] ? CATS[0].id : null;
}
function catScheduleLabel(cat){
    if(cat.anytime) return 'Anytime';
    var enabledDays=[]; for(var d=0;d<7;d++){ if(cat.schedule[d]&&cat.schedule[d].enabled) enabledDays.push(d); }
    if(enabledDays.length===0) return 'Manual only';
    var first=cat.schedule[enabledDays[0]];
    var same=enabledDays.every(function(d){ return cat.schedule[d].start===first.start&&cat.schedule[d].end===first.end; });
    var range=fmtTimeShort(first.start)+'-'+fmtTimeShort(first.end);
    if(same&&enabledDays.length===7) return range;
    if(same) return range+' ('+enabledDays.length+'d)';
    return 'Varies by day';
}
function fmtTimeShort(hhmm){
    var p=hhmm.split(':'); var h=parseInt(p[0],10), m=parseInt(p[1],10);
    var ap=h>=12?'PM':'AM'; var h12=h%12; if(h12===0)h12=12;
    return h12+(m>0?':'+pad2(m):'')+ap;
}
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function contrastColor(hex){
    var c=(hex||'#00c49a').replace('#',''); if(c.length===3) c=c.split('').map(function(x){return x+x;}).join('');
    var r=parseInt(c.substr(0,2),16)||0, g=parseInt(c.substr(2,2),16)||0, b=parseInt(c.substr(4,2),16)||0;
    var yiq=(r*299+g*587+b*114)/1000;
    return yiq>=140?'#0a0a0a':'#ffffff';
}
function lighten(hex, amt){
    var c=(hex||'#00c49a').replace('#',''); if(c.length===3) c=c.split('').map(function(x){return x+x;}).join('');
    var r=parseInt(c.substr(0,2),16)||0, g=parseInt(c.substr(2,2),16)||0, b=parseInt(c.substr(4,2),16)||0;
    r=Math.min(255,r+amt); g=Math.min(255,g+amt); b=Math.min(255,b+amt);
    return '#'+[r,g,b].map(function(x){ return Math.round(x).toString(16).padStart(2,'0'); }).join('');
}
function notify(msg){ var el=document.getElementById('notification'); el.textContent=msg; el.classList.add('show'); setTimeout(function(){ el.classList.remove('show'); },2500); }

var CAT_THEMES={
    dayStudy:    {accent:'#00c49a',accent2:'#00e5b3',accentText:'#00c49a'},
    eveningStudy:{accent:'#d63384',accent2:'#e8579e',accentText:'#d63384'},
    career:      {accent:'#d4a017',accent2:'#e8b828',accentText:'#d4a017'}
};
function applyTheme(id){
    var cat=CATS.find(function(c){ return c.id===id; })||CATS[0];
    if(!cat) return;
    document.documentElement.style.setProperty('--accent',cat.color);
    document.documentElement.style.setProperty('--accent2',lighten(cat.color,30));
    document.documentElement.style.setProperty('--accent-text',cat.color);
}

function switchTab(id){
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active',t.dataset.tab===id); });
    document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
    document.getElementById('panel-'+id).classList.add('active');
    if(id==='history') { renderHistory(); if(histView==='weekday') renderCompare(); }
    if(id==='today' && window._renderTodayHero) window._renderTodayHero();
    if(id==='compare') renderCompare();
    if(id==='export') renderSummary();
    if(id==='friends' && window._renderFriends) window._renderFriends();
}

// History tab has two views: day-by-day log, and the weekday comparison (old Compare tab)
var histView = 'days';
function setHistView(v){
    histView = v;
    document.querySelectorAll('#histSeg button').forEach(function(b){ b.classList.toggle('on', b.dataset.hv === v); });
    document.getElementById('histDays').style.display = v === 'days' ? 'block' : 'none';
    document.getElementById('panel-compare').style.display = v === 'weekday' ? 'block' : 'none';
    document.getElementById('histTitle').innerHTML = v === 'days' ? 'Logbook<small>Every session, day by day.</small>' : 'Weekday analysis<small>How each day of the week stacks up.</small>';
    if (v === 'weekday') { buildDaySelector(); renderCompare(); } else renderHistory();
}

function toggleAims(){ aimOpen=!aimOpen; document.getElementById('aimBody').style.display=aimOpen?'block':'none'; document.getElementById('aimChevron').classList.toggle('up',!aimOpen); }

function loadAims(){
    var today=getTodayKey();
    var day=getOrCreate(today); // creates today's entry with default goals prefilled if it doesn't exist yet
    var a=day.aims||{};
    CATS.forEach(function(c){ var v=a[c.id]||0; document.getElementById('aim-'+c.id).value=v?minsToDecimal(v):''; updateAimHint(c.id); });
}

function updateAimHint(catId){ var v=document.getElementById('aim-'+catId).value; document.getElementById('aimHint-'+catId).textContent=(v&&parseFloat(v)>0)?'= '+hoursToMins(v)+' mins':''; }

function saveAims(){
    var today=getTodayKey(); var day=getOrCreate(today);
    CATS.forEach(function(c){ day.aims[c.id]=hoursToMins(document.getElementById('aim-'+c.id).value); });
    saveDB(); notify('Aims saved'); renderProgress();
}

// Pulls each category's default goal for today's weekday into today's aims (overwrites whatever is there)
function applyDefaultGoalsToday(){
    var today=getTodayKey(); var day=getOrCreate(today);
    var dow=new Date().getDay();
    CATS.forEach(function(c){ day.aims[c.id]=(c.defaultGoal&&c.defaultGoal[dow])||0; });
    saveDB(); loadAims(); renderProgress();
    notify('Default goals applied to today');
}

function renderCatBtns(){
    var container=document.getElementById('catSelector'); var auto=getAutoCat(); container.innerHTML='';
    CATS.forEach(function(cat){
        var btn=document.createElement('button');
        btn.className='cat-btn';
        var isActive=currentCat===cat.id;
        if(isActive){
            btn.style.background=cat.color;
            btn.style.borderColor=cat.color;
            btn.style.color=contrastColor(cat.color);
        }
        btn.innerHTML=escapeHtml(cat.label)+(auto===cat.id&&!running?' <span class="auto-tag">AUTO</span>':'');
        btn.onclick=function(){ if(running){notify('Stop the timer first');return;} currentCat=cat.id; renderCatBtns(); applyTheme(cat.id); };
        container.appendChild(btn);
    });
}

function setMode(mode){
    if(running){notify('Stop the timer first');return;}
    currentMode=mode;
    document.getElementById('modeStopwatch').classList.toggle('active',mode==='stopwatch');
    document.getElementById('modeTimer').classList.toggle('active',mode==='timer');
    document.getElementById('modePomodoro').classList.toggle('active',mode==='pomodoro');
    document.getElementById('countdownRow').style.display=mode==='timer'?'flex':'none';
    document.getElementById('pomodoroRow').style.display=mode==='pomodoro'?'flex':'none';
    resetTimer();
}
var paused = false;

function pauseTimer() {
    if (!running) return;
    running = false;
    paused = true;
    clearInterval(interval);
    // elapsedMs already holds the time up to this point
    document.getElementById('pauseBtn').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>Resume';
    document.getElementById('timerDisplay').classList.remove('running');
    addLogEntry('notif', 'Timer paused at ' + document.getElementById('timerDisplay').textContent);
}

function toggleTimer() {
    if (paused) {
        // Resume from pause
        paused = false;
        running = true;
        startTime = Date.now() - elapsedMs;
        if (currentMode === 'timer' || currentMode === 'pomodoro') {
            startTime = Date.now() - (countdownTotal - elapsedMs);
        }
        interval = setInterval(tick, 100);
        document.getElementById('startStopBtn').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop';
        document.getElementById('startStopBtn').style.background = 'var(--red)';
        document.getElementById('pauseBtn').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause';
        document.getElementById('timerDisplay').classList.add('running');
        return;
    }
    running ? stopTimer() : startTimer();
}

// ── Pomodoro state ──
var pomPhase='work'; // 'work' or 'break'
var pomCyclesDone=0;
var pomTotalCycles=4;
var pomWorkMs=0;
var pomBreakMs=0;
var pomPhaseStartTime=0;
var breakReminderSent=false; // tracks if 55-min stopwatch reminder already fired this session
var lastBreakReminderHour=0; // tracks how many 1-hour reminders have been sent

function pomUpdateStatus(){
    var el=document.getElementById('pomStatus');
    if(!el)return;
    var phaseLabel=pomPhase==='work'?'Work':'Break';
    el.textContent=phaseLabel+' — Cycle '+(pomCyclesDone+1)+' of '+pomTotalCycles;
    el.style.color=pomPhase==='work'?'var(--accent)':'#888';
}

// ── Notifications ──
function requestNotifPerms(){
    if('Notification' in window && Notification.permission==='default'){
        Notification.requestPermission();
    }
}
function sendNotif(title, body){
    // Browser notification
    if('Notification' in window && Notification.permission==='granted'){
        new Notification(title,{body:body,icon:'icon-192.png',silent:false});
    }
    // In-app notify
    notify(title+': '+body);
    // Audio beep
    try{
        var ctx=new(window.AudioContext||window.webkitAudioContext)();
        var osc=ctx.createOscillator();
        var gain=ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value=880; osc.type='sine';
        gain.gain.setValueAtTime(0.4,ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.6);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.6);
    }catch(e){}
}

function checkCatSwitch(){
    var auto=getAutoCat();
    if(!running && auto!==currentCat){
        currentCat=auto;
        renderCatBtns();
        applyTheme(auto);
        var cat=CATS.find(function(c){return c.id===auto;});
        if(cat) sendNotif('Category switched','Now in '+cat.label);
        addLogEntry('notif','Auto-switched to '+(cat?cat.label:auto));
    }
}

function startTimer(){
    requestNotifPerms();
    if(currentMode==='timer'){
        var h=parseInt(document.getElementById('cdH').value)||0;
        var m=parseInt(document.getElementById('cdM').value)||0;
        countdownTotal=(h*60+m)*60000;
        if(countdownTotal<=0){notify('Set a duration first');return;}
    }
    if(currentMode==='pomodoro'){
        pomWorkMs=(parseInt(document.getElementById('pomWork').value)||25)*60000;
        pomBreakMs=(parseInt(document.getElementById('pomBreak').value)||5)*60000;
        pomTotalCycles=parseInt(document.getElementById('pomCycles').value)||4;
        pomCyclesDone=0; pomPhase='work';
        countdownTotal=pomWorkMs;
        pomUpdateStatus();
    }
    running=true; startTime=Date.now()-elapsedMs; sessionStart=new Date();
    breakReminderSent=false;
    lastBreakReminderHour=0;
    pomPhaseStartTime=Date.now();
    var catObj=CATS.find(function(c){return c.id===currentCat;});
    addLogEntry('session', currentMode.charAt(0).toUpperCase()+currentMode.slice(1)+' started — '+(catObj?catObj.label:currentCat));
    if (window._fireSessionState) window._fireSessionState({active:true, cat:currentCat, startedAt:Date.now()});
    interval=setInterval(tick,100);
    document.getElementById('startStopBtn').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop';
    document.getElementById('startStopBtn').style.background='var(--red)';
    document.getElementById('pauseBtn').style.display='flex';
    document.getElementById('timerDisplay').classList.add('running');
}

function stopTimer(){
    if(!running)return; running=false; paused=false; clearInterval(interval);
    if (window._fireSessionState) window._fireSessionState({active:false, cat:currentCat, startedAt:0});
    document.getElementById('pauseBtn').style.display='none';
    document.getElementById('pauseBtn').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause';
    if(currentMode==='pomodoro'){
        // Only record work time spent so far in this phase
        if(pomPhase==='work'){
            var worked=Math.round((Date.now()-pomPhaseStartTime)/60000);
            if(worked>0) recordSession(currentCat,worked);
        }
        elapsedMs=0;
        document.getElementById('timerDisplay').textContent='00:00:00';
        document.getElementById('pomStatus').textContent='';
    } else {
        var mins=Math.round((Date.now()-startTime)/60000);
        if(mins>0) recordSession(currentCat,mins);
        elapsedMs=0;
        document.getElementById('timerDisplay').textContent='00:00:00';
    }
    document.getElementById('startStopBtn').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
    document.getElementById('startStopBtn').style.background='var(--accent)';
    document.getElementById('timerDisplay').classList.remove('running');
}

function resetTimer(){
    if(running){clearInterval(interval);running=false;}
    paused=false; elapsedMs=0; startTime=null; pomPhase='work'; pomCyclesDone=0;
    document.getElementById('pauseBtn').style.display='none';
    document.getElementById('pauseBtn').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause';
    document.getElementById('startStopBtn').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
    document.getElementById('startStopBtn').style.background='var(--accent)';
    document.getElementById('timerDisplay').textContent='00:00:00';
    document.getElementById('timerDisplay').classList.remove('running');
    var ps=document.getElementById('pomStatus'); if(ps) ps.textContent='';
}

function tick(){
    var ms;
    if(currentMode==='stopwatch'){
        ms=Date.now()-startTime;
        elapsedMs=ms;
        document.getElementById('timerDisplay').textContent=formatMs(ms);
        // Hourly break reminder — fires every full hour
        var hoursElapsed = Math.floor(ms / (60 * 60 * 1000));
        if(hoursElapsed > 0 && hoursElapsed > lastBreakReminderHour){
            lastBreakReminderHour = hoursElapsed;
            sendNotif('Take a break', "You've been studying for " + hoursElapsed + " hour" + (hoursElapsed > 1 ? 's' : '') + ". Consider a short break!");
            addLogEntry('notif', hoursElapsed + ' hour' + (hoursElapsed>1?'s':'') + ' studied — break reminder sent.');
        }
        return;
    }
    // Timer and Pomodoro both count down
    ms=countdownTotal-(Date.now()-startTime);
    if(ms<=0){
        if(currentMode==='timer'){
            document.getElementById('timerDisplay').textContent='00:00:00';
            var el=countdownTotal; running=false; clearInterval(interval);
            var mins=Math.round(el/60000);
            if(mins>0) recordSession(currentCat,mins);
            document.getElementById('startStopBtn').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
            document.getElementById('startStopBtn').style.background='var(--accent)';
            document.getElementById('timerDisplay').classList.remove('running');
            elapsedMs=0;
            sendNotif('Timer complete','Session saved.');
            return;
        }
        if(currentMode==='pomodoro'){
            if(pomPhase==='work'){
                // Record work session
                var workedMins=Math.round(pomWorkMs/60000);
                if(workedMins>0) recordSession(currentCat,workedMins);
                pomCyclesDone++;
                if(pomCyclesDone>=pomTotalCycles){
                    // All cycles done
                    running=false; clearInterval(interval);
                    document.getElementById('startStopBtn').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
                    document.getElementById('startStopBtn').style.background='var(--accent)';
                    document.getElementById('timerDisplay').classList.remove('running');
                    document.getElementById('timerDisplay').textContent='00:00:00';
                    document.getElementById('pomStatus').textContent='All '+pomTotalCycles+' cycles complete!';
                    elapsedMs=0;
                    sendNotif('Pomodoro complete','All '+pomTotalCycles+' cycles done. Great work!');
                    return;
                }
                // Switch to break
                pomPhase='break';
                countdownTotal=pomBreakMs;
                startTime=Date.now(); elapsedMs=0; pomPhaseStartTime=Date.now();
                pomUpdateStatus();
                sendNotif('Break time','Work session done. Take a '+(pomBreakMs/60000)+' min break.');
            } else {
                // Break done, switch to work
                pomPhase='work';
                countdownTotal=pomWorkMs;
                startTime=Date.now(); elapsedMs=0; pomPhaseStartTime=Date.now();
                pomUpdateStatus();
                sendNotif('Back to work','Break over. Cycle '+(pomCyclesDone+1)+' of '+pomTotalCycles+'.');
            }
            return;
        }
    }
    elapsedMs=ms;
    document.getElementById('timerDisplay').textContent=formatMs(ms);
}

function recordSession(catId,mins){
    var today=getTodayKey(); var day=getOrCreate(today);
    day.actual[catId]=(day.actual[catId]||0)+mins;
    day.sessions.push({category:catId,startWall:sessionStart?sessionStart.toISOString():new Date().toISOString(),endWall:new Date().toISOString(),duration:mins});
    saveDB(); renderProgress();
    var cat=CATS.find(function(c){ return c.id===catId; });
    notify('+'+minsToHours(mins)+' — '+cat.label);
    addLogEntry('session', '+' + minsToHours(mins) + ' saved — ' + (cat ? cat.label : catId));
}

function renderProgress(){
    var today=getTodayKey(); var day=db[today]||{aims:{},actual:{}}; var container=document.getElementById('progressCards'); container.innerHTML='';
    CATS.forEach(function(cat){
        var aim=(day.aims&&day.aims[cat.id])||0; var actual=(day.actual&&day.actual[cat.id])||0;
        var pct=aim>0?Math.min((actual/aim)*100,100):(actual>0?100:0); var over=aim>0&&actual>aim;
        var card=document.createElement('div'); card.className='card progress-card';
        card.innerHTML='<div class="progress-top"><div class="progress-cat"><div class="progress-dot" style="background:'+cat.color+'"></div>'+escapeHtml(cat.label)+'<span class="progress-hours-badge">'+catScheduleLabel(cat)+'</span></div><div class="progress-stats"><strong>'+minsToHours(actual)+'</strong> / '+(aim>0?minsToHours(aim):'no aim')+(over?'<span class="over-tag" style="color:'+cat.color+'">+'+minsToHours(actual-aim)+'</span>':'')+'</div></div><div class="bar-bg"><div class="bar-fill" style="width:'+pct+'%;background:'+cat.color+'"></div></div>';
        container.appendChild(card);
    });
}

function renderHistory(){
    var container=document.getElementById('historyList'); var keys=Object.keys(db).sort().reverse();
    if(keys.length===0){container.innerHTML='<div class="empty">No history yet. Start your first session!</div>';return;}
    container.innerHTML='';
    keys.forEach(function(k){
        var day=db[k]; var date=new Date(k+'T12:00:00');
        var totalA=CATS.reduce(function(s,c){ return s+((day.actual&&day.actual[c.id])||0); },0);
        var totalAim=CATS.reduce(function(s,c){ return s+((day.aims&&day.aims[c.id])||0); },0);
        var denom=Math.max(totalAim,totalA,1);
        var segments='';
        CATS.forEach(function(cat){ var a=(day.actual&&day.actual[cat.id])||0; if(a<=0)return; var pct=Math.min((a/denom)*100,100); segments+='<div style="width:'+pct+'%;height:100%;background:'+cat.color+';"></div>'; });
        var sessHtml='';
        if(day.sessions&&day.sessions.length>0){
            day.sessions.slice().reverse().forEach(function(s){ var cat=CATS.find(function(c){return c.id===s.category;}); var st=s.startWall?new Date(s.startWall).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''; var en=s.endWall?new Date(s.endWall).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''; sessHtml+='<div class="session-item"><div><span class="session-cat" style="color:'+(cat?cat.color:'#888')+'">'+(cat?cat.label:s.category)+'</span><span class="session-time">'+st+(en?' → '+en:'')+'</span></div><div class="session-dur">'+minsToHours(s.duration)+'</div></div>'; });
        }
        var isToday = (k === getTodayKey());
        var cardId='hday-'+k; var card=document.createElement('div'); card.className='history-day-card';
        card.innerHTML='<div class="history-day-header" onclick="toggleHistoryDay(\''+cardId+'\')"><div><div class="history-date-main">'+date.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+'</div><div class="history-date-sub">'+date.getFullYear()+'</div></div><div class="history-right"><div class="history-total-val">'+minsToHours(totalA)+'</div>'+(totalAim>0?'<div class="history-total-aimed">/ '+minsToHours(totalAim)+' aimed</div>':'')+'</div></div><div class="history-bar-wrap"><div style="height:4px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden;display:flex;">'+segments+'</div></div>'+(sessHtml?'<div class="history-sessions-wrap" id="'+cardId+'" style="display:'+(isToday?'block':'none')+';">'+sessHtml+'</div>':'');
        container.appendChild(card);
    });
}

function toggleHistoryDay(id){ var el=document.getElementById(id); if(!el)return; el.style.display=el.style.display==='none'?'block':'none'; }

function buildDaySelector(){
    var container=document.getElementById('daySelector'); container.innerHTML='';
    WEEKDAYS.forEach(function(day,i){ var btn=document.createElement('button'); btn.className='day-btn'+(compareDay===i?' active':''); btn.textContent=day; btn.onclick=function(){ compareDay=i; buildDaySelector(); renderCompare(); }; container.appendChild(btn); });
}

function renderCompare(){
    var container=document.getElementById('compareContent');
    var entries=Object.keys(db).filter(function(k){ return new Date(k+'T12:00:00').getDay()===compareDay; }).sort();
    if(entries.length===0){container.innerHTML='<div class="empty">No '+WEEKDAYS[compareDay]+' data yet. Keep tracking!</div>';return;}
    Object.keys(charts).forEach(function(k){ if(charts[k])charts[k].destroy(); }); charts={};
    var avg={total:0}; CATS.forEach(function(c){ avg[c.id]=0; });
    var best={date:'',total:0};
    entries.forEach(function(k){ var d=db[k]; CATS.forEach(function(c){ avg[c.id]+=(d.actual&&d.actual[c.id])||0; }); var t=CATS.reduce(function(s,c){ return s+((d.actual&&d.actual[c.id])||0); },0); avg.total+=t; if(t>best.total){best.total=t;best.date=k;} });
    var n=entries.length; CATS.forEach(function(c){ avg[c.id]/=n; }); avg.total/=n;
    var labels=entries.map(function(k){ var d=new Date(k+'T12:00:00'); return (d.getMonth()+1)+'/'+d.getDate(); });
    var dataByCat=CATS.map(function(c){ return entries.map(function(k){ return (db[k].actual&&db[k].actual[c.id])||0; }); });
    var dataTotal=entries.map(function(k){ return CATS.reduce(function(s,c){ return s+((db[k].actual&&db[k].actual[c.id])||0); },0); });
    var dataTotalAim=entries.map(function(k){ return CATS.reduce(function(s,c){ return s+((db[k].aims&&db[k].aims[c.id])||0); },0); });

    var html='<div class="stat-grid"><div class="stat-card"><div class="stat-label">Average Total</div><div class="stat-value" style="color:var(--accent)">'+minsToHours(Math.round(avg.total))+'</div></div><div class="stat-card"><div class="stat-label">Best '+WEEKDAYS[compareDay]+'</div><div class="stat-value">'+minsToHours(best.total)+'</div><div class="stat-sub">'+best.date+'</div></div><div class="stat-card"><div class="stat-label">'+WEEKDAYS[compareDay]+'s Tracked</div><div class="stat-value">'+n+'</div></div></div>';
    html+='<div class="chart-row"><div class="card chart-card"><div class="chart-title">Hours by Category</div><div class="chart-wrap"><canvas id="chart-stacked"></canvas></div></div><div class="card chart-card"><div class="chart-title">Total Trend</div><div class="chart-wrap"><canvas id="chart-trend"></canvas></div></div></div>';
    html+='<div class="chart-row"><div class="card chart-card"><div class="chart-title">Avg Distribution</div><div class="chart-wrap"><canvas id="chart-pie"></canvas></div></div><div class="card chart-card"><div class="chart-title">Aim vs Actual (Avg)</div><div class="chart-wrap"><canvas id="chart-radar"></canvas></div></div></div>';
    html+='<div class="card chart-card"><div class="chart-title">Actual vs Aim per Entry</div><div class="chart-wrap"><canvas id="chart-aimbar"></canvas></div></div>';
    var hasScatter=entries.some(function(k){ return CATS.reduce(function(s,c){ return s+((db[k].aims&&db[k].aims[c.id])||0); },0)>0; });
    if(hasScatter) html+='<div class="card chart-card"><div class="chart-title">Aim vs Actual (Scatter)</div><div style="font-size:10px;color:var(--text3);margin-bottom:12px;">Teal = hit aim, red = missed</div><div class="chart-wrap"><canvas id="chart-scatter"></canvas></div></div>';
    html+='<div class="table-wrap"><table><thead><tr><th>Date</th>';
    CATS.forEach(function(c){ html+='<th>'+c.label+'</th>'; });
    html+='<th>Total</th><th>Hit?</th></tr></thead><tbody>';
    entries.slice().reverse().forEach(function(k){ var d=db[k]; var date=new Date(k+'T12:00:00'); var totalA=CATS.reduce(function(s,c){ return s+((d.actual&&d.actual[c.id])||0); },0); var totalAim=CATS.reduce(function(s,c){ return s+((d.aims&&d.aims[c.id])||0); },0); var hit=totalAim>0&&totalA>=totalAim; html+='<tr><td><strong>'+date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+'</strong></td>'; CATS.forEach(function(c){ var a=(d.actual&&d.actual[c.id])||0; var aim=(d.aims&&d.aims[c.id])||0; html+='<td><span style="color:'+c.color+'">'+minsToHours(a)+'</span>'+(aim>0?'<span style="color:var(--text3);font-size:10px"> / '+minsToHours(aim)+'</span>':'')+'</td>'; }); html+='<td><strong>'+minsToHours(totalA)+'</strong>'+(totalAim>0?'<span style="color:var(--text3);font-size:10px"> / '+minsToHours(totalAim)+'</span>':'')+'</td><td>'+(totalAim>0?(hit?'<span style="color:#00c49a">&#10003;</span>':'<span style="color:var(--red)">&#10007;</span>'):'<span style="color:var(--text3)">&#8212;</span>')+'</td></tr>'; });
    html+='</tbody></table></div>';
    container.innerHTML=html;

    Chart.defaults.color='#555'; Chart.defaults.borderColor='rgba(255,255,255,0.07)'; Chart.defaults.font.family="'DM Sans', sans-serif"; Chart.defaults.font.size=11;
    var tt={backgroundColor:'rgba(15,15,15,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,titleColor:'#f0f0f0',bodyColor:'#888',cornerRadius:6,padding:9,callbacks:{label:function(ctx){ return ctx.dataset.label+': '+minsToHours(ctx.parsed.y||ctx.parsed||0); }}};

    var stackedDatasets=CATS.map(function(c,i){ return {label:c.label,data:dataByCat[i],backgroundColor:c.color,borderRadius:(i===CATS.length-1)?{topLeft:4,topRight:4}:2}; });
    charts.stacked=new Chart(document.getElementById('chart-stacked'),{type:'bar',data:{labels:labels,datasets:stackedDatasets},options:{responsive:true,plugins:{tooltip:tt,legend:{labels:{boxWidth:8,padding:10,color:'#888'}}},scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,ticks:{callback:function(v){ return minsToDecimal(v)+'h'; },color:'#555'},grid:{color:'rgba(255,255,255,0.05)'}}}}});
    charts.trend=new Chart(document.getElementById('chart-trend'),{type:'line',data:{labels:labels,datasets:[{label:'Actual',data:dataTotal,borderColor:'#00c49a',backgroundColor:'rgba(0,196,154,0.08)',fill:true,tension:0.3,pointRadius:3,pointBackgroundColor:'#00c49a'},{label:'Aim',data:dataTotalAim,borderColor:'rgba(255,255,255,0.2)',borderDash:[4,4],tension:0.3,pointRadius:2,fill:false}]},options:{responsive:true,plugins:{tooltip:tt,legend:{labels:{boxWidth:8,padding:10,color:'#888'}}},scales:{x:{grid:{display:false},ticks:{color:'#555'}},y:{ticks:{callback:function(v){ return minsToDecimal(v)+'h'; },color:'#555'},grid:{color:'rgba(255,255,255,0.05)'}}}}});
    charts.pie=new Chart(document.getElementById('chart-pie'),{type:'doughnut',data:{labels:CATS.map(function(c){ return c.label; }),datasets:[{data:CATS.map(function(c){ return Math.round(avg[c.id]); }),backgroundColor:CATS.map(function(c){ return c.color; }),borderWidth:0}]},options:{responsive:true,cutout:'55%',plugins:{tooltip:{backgroundColor:'rgba(15,15,15,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,callbacks:{label:function(ctx){ return ctx.label+': '+minsToHours(ctx.parsed); }}},legend:{position:'bottom',labels:{boxWidth:8,padding:10,font:{size:10},color:'#888'}}}}});
    var radarAim=CATS.map(function(c){ return Math.round(entries.reduce(function(s,k){ return s+((db[k].aims&&db[k].aims[c.id])||0); },0)/n); });
    charts.radar=new Chart(document.getElementById('chart-radar'),{type:'radar',data:{labels:CATS.map(function(c){ return c.label; }),datasets:[{label:'Actual',data:CATS.map(function(c){ return Math.round(avg[c.id]); }),borderColor:'#00c49a',backgroundColor:'rgba(0,196,154,0.1)',pointBackgroundColor:'#00c49a'},{label:'Aim',data:radarAim,borderColor:'rgba(255,255,255,0.2)',backgroundColor:'rgba(255,255,255,0.03)',pointBackgroundColor:'rgba(255,255,255,0.3)'}]},options:{responsive:true,plugins:{tooltip:{backgroundColor:'rgba(15,15,15,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,callbacks:{label:function(ctx){ return ctx.dataset.label+': '+minsToHours(ctx.parsed.r); }}},legend:{position:'bottom',labels:{boxWidth:8,padding:10,font:{size:10},color:'#888'}}},scales:{r:{grid:{color:'rgba(255,255,255,0.07)'},angleLines:{color:'rgba(255,255,255,0.07)'},pointLabels:{font:{size:10},color:'#666'},ticks:{display:false}}}}});
    charts.aimbar=new Chart(document.getElementById('chart-aimbar'),{type:'bar',data:{labels:labels,datasets:[{label:'Actual',data:dataTotal,backgroundColor:'#00c49a',borderRadius:4},{label:'Aim',data:dataTotalAim,backgroundColor:'rgba(255,255,255,0.05)',borderColor:'rgba(255,255,255,0.2)',borderWidth:1,borderRadius:4}]},options:{responsive:true,plugins:{tooltip:tt,legend:{labels:{boxWidth:8,padding:10,color:'#888'}}},scales:{x:{grid:{display:false},ticks:{color:'#555'}},y:{ticks:{callback:function(v){ return minsToDecimal(v)+'h'; },color:'#555'},grid:{color:'rgba(255,255,255,0.05)'}}}}});
    if(hasScatter){ var sd=entries.map(function(k){ var tA=CATS.reduce(function(s,c){ return s+((db[k].aims&&db[k].aims[c.id])||0); },0); var ta=CATS.reduce(function(s,c){ return s+((db[k].actual&&db[k].actual[c.id])||0); },0); return{x:tA,y:ta}; }).filter(function(d){ return d.x>0; }); charts.scatter=new Chart(document.getElementById('chart-scatter'),{type:'scatter',data:{datasets:[{label:'Sessions',data:sd,backgroundColor:sd.map(function(d){ return d.y>=d.x?'#00c49a':'#e05252'; }),pointRadius:6,pointHoverRadius:8}]},options:{responsive:true,plugins:{tooltip:{backgroundColor:'rgba(15,15,15,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,callbacks:{label:function(ctx){ return'Aim: '+minsToHours(ctx.parsed.x)+', Actual: '+minsToHours(ctx.parsed.y); }}},legend:{display:false}},scales:{x:{title:{display:true,text:'Aim',color:'#555'},ticks:{callback:function(v){ return minsToDecimal(v)+'h'; },color:'#555'},grid:{color:'rgba(255,255,255,0.05)'}},y:{title:{display:true,text:'Actual',color:'#555'},ticks:{callback:function(v){ return minsToDecimal(v)+'h'; },color:'#555'},grid:{color:'rgba(255,255,255,0.05)'}}}}});}
}

function getWeekRange(){ var d=new Date(),day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1),mon=new Date(d); mon.setDate(diff); var sun=new Date(mon); sun.setDate(mon.getDate()+6); var fmt=function(dt){ return dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate()); }; return{start:fmt(mon),end:fmt(sun)}; }
function buildCSV(keys){
    var csv='Date,Day';
    CATS.forEach(function(c){ csv+=','+c.label+' Aim (h),'+c.label+' Actual (h)'; });
    csv+=',Total Aim (h),Total Actual (h)\n';
    keys.forEach(function(k){
        var d=db[k], date=new Date(k+'T12:00:00');
        var tAim=CATS.reduce(function(s,c){ return s+((d.aims&&d.aims[c.id])||0); },0);
        var tAct=CATS.reduce(function(s,c){ return s+((d.actual&&d.actual[c.id])||0); },0);
        var row=k+','+WEEKDAYS[date.getDay()];
        CATS.forEach(function(c){ row+=','+minsToDecimal((d.aims&&d.aims[c.id])||0)+','+minsToDecimal((d.actual&&d.actual[c.id])||0); });
        row+=','+minsToDecimal(tAim)+','+minsToDecimal(tAct)+'\n';
        csv+=row;
    });
    return csv;
}
function download(name,content,type){ var blob=new Blob([content],{type:type}),a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); URL.revokeObjectURL(a.href); }
function exportWeekly(fmt){ var w=getWeekRange(),keys=Object.keys(db).filter(function(k){ return k>=w.start&&k<=w.end; }).sort(); if(fmt==='csv'){download('study-week-'+w.start+'.csv',buildCSV(keys),'text/csv');}else{var data={};keys.forEach(function(k){data[k]=db[k];});download('study-week-'+w.start+'.json',JSON.stringify(data,null,2),'application/json');} notify('Exported '+keys.length+' days'); }
function exportAll(fmt){ var keys=Object.keys(db).sort(); if(fmt==='csv'){download('study-all-data.csv',buildCSV(keys),'text/csv');}else{download('study-all-data.json',JSON.stringify(db,null,2),'application/json');} notify('Exported all data'); }
function renderSummary(){ var tD=Object.keys(db).length,tS=Object.values(db).reduce(function(s,d){ return s+(d.sessions?d.sessions.length:0); },0),tM=Object.values(db).reduce(function(s,d){ return s+CATS.reduce(function(cs,c){ return cs+((d.actual&&d.actual[c.id])||0); },0); },0),streak=getStreak(); document.getElementById('summaryGrid').innerHTML='<div><div class="summary-label">Total Days Tracked</div><div class="summary-val" style="color:var(--accent)">'+tD+'</div></div><div><div class="summary-label">Total Sessions</div><div class="summary-val">'+tS+'</div></div><div><div class="summary-label">Total Hours Logged</div><div class="summary-val">'+minsToHours(tM)+'</div></div><div><div class="summary-label">Current Streak</div><div class="summary-val">'+streak+' days</div></div>'; }
function getStreak(){ var streak=0,d=new Date(); for(var i=0;i<365;i++){var check=new Date(d);check.setDate(check.getDate()-i);var key=check.getFullYear()+'-'+pad2(check.getMonth()+1)+'-'+pad2(check.getDate());if(db[key]&&db[key].sessions&&db[key].sessions.length>0)streak++;else if(i>0)break;else break;} return streak; }
function updateStreak(){ var s=getStreak(),badge=document.getElementById('streakBadge'); if(s>0){badge.style.display='flex';document.getElementById('streakCount').textContent=s;}else{badge.style.display='none';} }
function deleteAllData(){ if(!confirm('Delete ALL study data? This cannot be undone.'))return; localStorage.removeItem(DB_KEY);db={};if(window._fireSave)window._fireSave({});activityLog=[];saveActivityLog();renderActivityLog();loadAims();renderProgress();updateStreak();buildDaySelector();renderSummary();if(typeof renderHistory==='function')renderHistory();notify('All data deleted'); }
function updateHeaderClock(){ var now=new Date(); document.getElementById('headerDate').textContent=now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}); document.getElementById('headerTime').textContent=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

/* ── IMPORT ── */
function importJSON(event) {
    var file = event.target.files[0];
    var statusEl = document.getElementById('importStatus');
    if (!file) return;
    if (!file.name.endsWith('.json')) {
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = 'Please select a .json file.';
        return;
    }
    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var imported = JSON.parse(e.target.result);
            if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Invalid format');
            // Validate it looks like Study Savvy data (keys should be YYYY-MM-DD)
            var keys = Object.keys(imported);
            var valid = keys.every(function(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k); });
            if (!valid && keys.length > 0) throw new Error('File does not look like a Study Savvy export');
            var added = 0, skipped = 0;
            keys.forEach(function(k) {
                if (!db[k]) { db[k] = imported[k]; added++; }
                else { skipped++; }
            });
            saveDB();
            loadAims();
            renderProgress();
            updateStreak();
            buildDaySelector();
            renderSummary();
            statusEl.style.color = 'var(--accent)';
            statusEl.textContent = added + ' day' + (added !== 1 ? 's' : '') + ' imported' + (skipped > 0 ? ', ' + skipped + ' already existed (kept).' : '.');
            notify('Import complete — ' + added + ' days added');
        } catch(err) {
            statusEl.style.color = 'var(--red)';
            statusEl.textContent = 'Import failed: ' + err.message;
        }
        // Reset input so same file can be re-selected if needed
        event.target.value = '';
    };
    reader.readAsText(file);
}

/* ── ACTIVITY LOG ── */
var LOG_KEY = 'studyLog_v1';
var activityLog = [];
var activityLogDate = getTodayKey();

function loadActivityLog() {
    try {
        var raw = JSON.parse(localStorage.getItem(LOG_KEY) || '{}');
        var today = getTodayKey();
        if (raw.date === today) {
            activityLog = raw.entries || [];
        } else {
            // New day — clear old log
            activityLog = [];
            saveActivityLog();
        }
        activityLogDate = today;
    } catch(e) { activityLog = []; }
}

function saveActivityLog() {
    var today = getTodayKey();
    localStorage.setItem(LOG_KEY, JSON.stringify({date: today, entries: activityLog}));
    // Sync to Firestore
    if (window._fireLogSave) window._fireLogSave({date: today, entries: activityLog});
}

function checkMidnightLogReset() {
    var today = getTodayKey();
    if (today !== activityLogDate) {
        activityLog = [];
        activityLogDate = today;
        saveActivityLog();
        renderActivityLog();
    }
}

function addLogEntry(type, msg) {
    var now = new Date();
    var time = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    activityLog.push({time: time, type: type, msg: msg, ts: Date.now()});
    saveActivityLog();
    renderActivityLog();
}

function renderActivityLog() {
    var el = document.getElementById('activityLog');
    if (!el) return;
    if (activityLog.length === 0) {
        el.innerHTML = '<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0;">No activity yet today.</div>';
        return;
    }
    var colors = {session:'var(--accent)', sleep:'#d4a017', notif:'#888', note:'var(--text2)', warning:'var(--red)'};
    el.innerHTML = activityLog.slice().reverse().map(function(e) {
        var col = colors[e.type] || '#888';
        return '<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--border);">' +
            '<span style="font-size:10px;color:var(--text3);font-family:\'JetBrains Mono\',monospace;flex-shrink:0;padding-top:1px;">' + e.time + '</span>' +
            '<span style="font-size:11px;color:' + col + ';line-height:1.4;">' + e.msg + '</span>' +
            '</div>';
    }).join('');
}

function clearActivityLog() {
    activityLog = [];
    saveActivityLog();
    renderActivityLog();
}

function addManualLogNote() {
    var input = document.getElementById('logNoteInput');
    var val = input.value.trim();
    if (!val) return;
    addLogEntry('note', val);
    input.value = '';
}

// Bridges for Firebase module
window._getActivityLog = function() {
    return { date: getTodayKey(), entries: activityLog };
};
window._mergeActivityLog = function(cloudLog) {
    var today = getTodayKey();
    if (cloudLog.date !== today) return;
    var localTs = new Set(activityLog.map(function(e){ return e.ts; }));
    var merged = activityLog.slice();
    (cloudLog.entries || []).forEach(function(e) {
        if (!localTs.has(e.ts)) merged.push(e);
    });
    merged.sort(function(a,b){ return a.ts - b.ts; });
    activityLog = merged;
    localStorage.setItem(LOG_KEY, JSON.stringify({date: today, entries: activityLog}));
    renderActivityLog();
};

/* ── CATEGORY MANAGEMENT (add / delete / recolor / rename / per-day schedule) ── */

// Builds the aim-card rows dynamically so they always match the current category list
function renderAimRows(){
    var container=document.getElementById('aimStack');
    if(!container) return;
    var html='';
    CATS.forEach(function(c){
        html+='<div>';
        html+='<div class="aim-row">';
        html+='<div class="aim-dot" style="background:'+c.color+';"></div>';
        html+='<div class="aim-row-label" id="aimLabel-'+c.id+'">'+escapeHtml(c.label)+'<span>'+catScheduleLabel(c)+'</span></div>';
        html+='<div class="input-wrap" style="flex:1;"><input type="number" step="0.1" min="0" class="input" id="aim-'+c.id+'" placeholder="0" style="padding-right:40px;"><span class="input-suffix">hrs</span></div>';
        html+='</div>';
        html+='<div class="input-hint" id="aimHint-'+c.id+'" style="padding-left:18px;margin-top:2px;"></div>';
        html+='</div>';
    });
    container.innerHTML=html;
    CATS.forEach(function(c){ var el=document.getElementById('aim-'+c.id); if(el) el.addEventListener('input',function(){ updateAimHint(c.id); }); });
}

// Keeps the manual-session category dropdown (Export tab) in sync with current categories
function populateManualCatSelect(){
    var sel=document.getElementById('manualCat');
    if(!sel) return;
    var prev=sel.value;
    sel.innerHTML='';
    CATS.forEach(function(c){
        var opt=document.createElement('option');
        opt.value=c.id; opt.textContent=c.label;
        sel.appendChild(opt);
    });
    if(CATS.some(function(c){ return c.id===prev; })) sel.value=prev;
}

// Renders the "Manage Categories" card: one editable block per category
function renderCatManageList(){
    var container=document.getElementById('catManageList');
    if(!container) return;
    var html='';
    CATS.forEach(function(c){
        html+='<div class="cat-manage-row" style="border:1px solid var(--border);border-radius:8px;padding:10px;">';
        html+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">';
        html+='<input type="color" id="catEditColor-'+c.id+'" value="'+c.color+'" style="width:28px;height:28px;border:none;background:none;padding:0;cursor:pointer;flex-shrink:0;">';
        html+='<input type="text" id="catEditName-'+c.id+'" class="input" style="font-size:12px;flex:1;" value="'+escapeHtml(c.label)+'" maxlength="24">';
        html+='<button class="btn btn-ghost btn-sm" onclick="deleteCategory(\''+c.id+'\')" style="color:var(--red);white-space:nowrap;">Delete</button>';
        html+='</div>';
        html+='<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);margin-bottom:6px;cursor:pointer;">';
        html+='<input type="checkbox" id="catEditAnytime-'+c.id+'" '+(c.anytime?'checked':'')+' onchange="document.getElementById(\'sch-block-'+c.id+'\').style.display=this.checked?\'none\':\'block\';">';
        html+='Anytime (no auto-switch schedule — this category is only ever chosen manually)</label>';
        html+='<div id="sch-block-'+c.id+'" style="display:'+(c.anytime?'none':'block')+';">';
        html+='<div style="font-size:10px;color:var(--text3);margin-bottom:4px;">Auto-switch into this category on the checked days, during these times:</div>';
        WEEKDAYS.forEach(function(wd,d){
            var sch=c.schedule[d];
            html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">';
            html+='<input type="checkbox" id="sch-'+c.id+'-'+d+'-enabled" '+(sch.enabled?'checked':'')+'>';
            html+='<span style="font-size:11px;color:var(--text2);width:34px;">'+wd.slice(0,3)+'</span>';
            html+='<input type="time" id="sch-'+c.id+'-'+d+'-start" value="'+sch.start+'" class="input" style="font-size:11px;padding:4px 6px;width:90px;">';
            html+='<span style="font-size:10px;color:var(--text3);">to</span>';
            html+='<input type="time" id="sch-'+c.id+'-'+d+'-end" value="'+sch.end+'" class="input" style="font-size:11px;padding:4px 6px;width:90px;">';
            if(d===0) html+='<button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:9px;" onclick="copyScheduleToAllDays(\''+c.id+'\',0)">Copy to all days</button>';
            html+='</div>';
        });
        html+='</div>';
        html+='<div style="font-size:10px;color:var(--text3);margin:10px 0 4px;">Default daily goal (hrs) — auto-fills the aim when a new day starts:</div>';
        html+='<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;">';
        WEEKDAYS.forEach(function(wd,d){
            var goalHrs=minsToDecimal(c.defaultGoal[d]||0);
            html+='<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">';
            html+='<span style="font-size:9px;color:var(--text3);">'+wd.slice(0,3)+'</span>';
            html+='<input type="number" step="0.1" min="0" id="goal-'+c.id+'-'+d+'" value="'+goalHrs+'" class="input" style="width:50px;font-size:11px;padding:4px;text-align:center;">';
            html+='</div>';
        });
        html+='<button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:9px;" onclick="copyGoalToAllDays(\''+c.id+'\',0)">Copy to all days</button>';
        html+='</div>';
        html+='</div>';
    });
    container.innerHTML=html;
}

// Copies one day's default-goal hours to every day for a category (still needs Save Categories to persist)
function copyGoalToAllDays(catId, sourceDay){
    var srcEl=document.getElementById('goal-'+catId+'-'+sourceDay);
    if(!srcEl) return;
    for(var d=0; d<7; d++){
        var el=document.getElementById('goal-'+catId+'-'+d);
        if(el) el.value=srcEl.value;
    }
    notify('Copied to all days — click Save Categories to apply');
}

// Copies one day's time range to every day for a category (still needs Save Categories to persist)
function copyScheduleToAllDays(catId, sourceDay){
    var stEl=document.getElementById('sch-'+catId+'-'+sourceDay+'-start');
    var enEl=document.getElementById('sch-'+catId+'-'+sourceDay+'-end');
    if(!stEl||!enEl) return;
    for(var d=0; d<7; d++){
        var chk=document.getElementById('sch-'+catId+'-'+d+'-enabled');
        var s=document.getElementById('sch-'+catId+'-'+d+'-start');
        var e=document.getElementById('sch-'+catId+'-'+d+'-end');
        if(chk) chk.checked=true;
        if(s) s.value=stEl.value;
        if(e) e.value=enEl.value;
    }
    notify('Copied to all days — click Save Categories to apply');
}

// Re-renders everything that depends on the category list after add/delete/save
function onCategoriesChanged(){
    renderCatManageList();
    renderAimRows();
    loadAims();
    renderCatBtns();
    applyTheme(currentCat);
    renderProgress();
    populateManualCatSelect();
}

function addCategory(){
    var id='cat_'+Date.now().toString(36);
    CATS.push({ id:id, label:'New Category', color:'#8888ff', anytime:true, schedule:buildSchedule('09:00','18:00',[]), defaultGoal:buildGoalSchedule(0) });
    saveCategories();
    onCategoriesChanged();
    notify('Category added — edit its name, colour, and schedule below');
}

function deleteCategory(id){
    if(CATS.length<=1){ notify('You need at least one category.'); return; }
    if(running && currentCat===id){ notify('Stop the timer before deleting the active category.'); return; }
    if(!confirm('Delete this category? Past logged data stays in your history, but this category will no longer be selectable.')) return;
    var idx=CATS.findIndex(function(c){ return c.id===id; });
    if(idx>=0) CATS.splice(idx,1);
    if(currentCat===id) currentCat=CATS[0].id;
    saveCategories();
    onCategoriesChanged();
    notify('Category deleted');
}

function saveCategoryEdits(){
    CATS.forEach(function(c){
        var nameEl=document.getElementById('catEditName-'+c.id);
        var colorEl=document.getElementById('catEditColor-'+c.id);
        var anytimeEl=document.getElementById('catEditAnytime-'+c.id);
        if(nameEl && nameEl.value.trim()) c.label=nameEl.value.trim();
        if(colorEl && colorEl.value) c.color=colorEl.value;
        if(anytimeEl) c.anytime=anytimeEl.checked;
        for(var d=0; d<7; d++){
            var chk=document.getElementById('sch-'+c.id+'-'+d+'-enabled');
            var s=document.getElementById('sch-'+c.id+'-'+d+'-start');
            var e=document.getElementById('sch-'+c.id+'-'+d+'-end');
            if(chk) c.schedule[d].enabled=chk.checked;
            if(s && s.value) c.schedule[d].start=s.value;
            if(e && e.value) c.schedule[d].end=e.value;
            var goalEl=document.getElementById('goal-'+c.id+'-'+d);
            if(goalEl) c.defaultGoal[d]=hoursToMins(goalEl.value);
        }
    });
    saveCategories();
    onCategoriesChanged();
    notify('Categories saved');
}

/* ── MANUAL SESSION ── */
function applyManualSession() {
    var dateVal = document.getElementById('manualDate').value;
    var cat = document.getElementById('manualCat').value;
    var mins = parseInt(document.getElementById('manualMins').value);
    var action = document.getElementById('manualAction').value;
    var note = document.getElementById('manualNote').value.trim();
    var statusEl = document.getElementById('manualStatus');

    if (!dateVal) { statusEl.style.color='var(--red)'; statusEl.textContent='Select a date.'; return; }
    if (!mins || mins <= 0) { statusEl.style.color='var(--red)'; statusEl.textContent='Enter a valid duration.'; return; }

    var day = getOrCreate(dateVal);
    var catObj = CATS.find(function(c){ return c.id === cat; });
    var label = catObj ? catObj.label : cat;

    if (action === 'add') {
        day.actual[cat] = (day.actual[cat] || 0) + mins;
        day.sessions.push({
            category: cat,
            startWall: dateVal + 'T00:00:00.000Z',
            endWall: dateVal + 'T00:00:00.000Z',
            duration: mins,
            manual: true,
            note: note || 'Manual addition'
        });
        statusEl.style.color = 'var(--accent)';
        statusEl.textContent = '+' + minsToHours(mins) + ' added to ' + label + ' on ' + dateVal;
        if (dateVal === getTodayKey()) addLogEntry('note', 'Manual add: +' + minsToHours(mins) + ' to ' + label + (note ? ' — ' + note : ''));
    } else {
        var current = day.actual[cat] || 0;
        var toRemove = Math.min(mins, current);
        day.actual[cat] = current - toRemove;
        statusEl.style.color = toRemove < mins ? '#d4a017' : 'var(--accent)';
        statusEl.textContent = '-' + minsToHours(toRemove) + ' removed from ' + label + ' on ' + dateVal + (toRemove < mins ? ' (capped at available time)' : '');
        if (dateVal === getTodayKey()) addLogEntry('note', 'Manual remove: -' + minsToHours(toRemove) + ' from ' + label + (note ? ' — ' + note : ''));
    }
    saveDB();
    renderProgress();
    renderSummary();
    document.getElementById('manualNote').value = '';
}

/* ── ACTIVE SESSION ON OTHER DEVICE ── */
function checkActiveSessionOnOtherDevice(cloudData) {
    if (!cloudData || !cloudData._activeSession) return;
    var s = cloudData._activeSession;
    // If it's from more than 10 mins ago and not this device, show banner
    var age = Date.now() - (s.startedAt || 0);
    if (age < 10 * 60 * 1000 && !running) {
        var cat = CATS.find(function(c){ return c.id === s.cat; });
        var banner = document.getElementById('activeSessionBanner');
        document.getElementById('activeSessionBannerText').textContent =
            'Session active on another device — ' + (cat ? cat.label : s.cat) + ', started ' + Math.round(age/60000) + ' min ago.';
        banner.style.display = 'flex';
    }
}

// Save active session flag to Firestore when running
function syncActiveSessionState() {
    if (!window._fireSave || !window.currentUser) return;
    // We piggyback on the db object temporarily — use a separate Firestore path ideally
    // For simplicity, store in a meta field on the user doc
    var meta = running ? { cat: currentCat, startedAt: sessionStart ? sessionStart.getTime() : Date.now() } : null;
    var payload = Object.assign({}, db);
    payload._activeSession = meta;
    if (window._fireSaveRaw) window._fireSaveRaw(payload);
}

/* ── PICTURE-IN-PICTURE ── */
var pipWindow = null;
var pipInterval = null;

function getPipCatInfo() {
    var cat = CATS.find(function(c){ return c.id === currentCat; }) || CATS[0];
    return cat;
}

function buildPipHTML(cat, timeStr) {
    var isBreak = currentMode === 'pomodoro' && pomPhase === 'break';
    var accentColor = isBreak ? '#666666' : cat.color;
    var btnBg = running ? '#e05252' : accentColor;
    var btnLabel = running ? '⏸ Stop' : '▶ Start';
    var phaseLabel = currentMode === 'pomodoro'
        ? (pomPhase === 'work' ? 'WORK — Cycle ' + (pomCyclesDone + 1) + '/' + pomTotalCycles : 'BREAK — Cycle ' + pomCyclesDone + '/' + pomTotalCycles)
        : cat.label;
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
        '@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@500;600&display=swap");' +
        '*{margin:0;padding:0;box-sizing:border-box;}' +
        'html,body{width:100%;height:100%;background:#0a0a0a;display:flex;align-items:center;justify-content:center;overflow:hidden;}' +
        '.pip-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;padding:10px 14px;}' +
        '.pip-cat{font-family:"DM Sans",sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:' + accentColor + ';}' +
        '.pip-time{font-family:"JetBrains Mono",monospace;font-size:36px;font-weight:600;color:' + (running ? accentColor : '#f0f0f0') + ';letter-spacing:-2px;line-height:1;}' +
        '.pip-btn{padding:5px 20px;border-radius:7px;border:none;font-family:"DM Sans",sans-serif;font-size:11px;font-weight:600;cursor:pointer;letter-spacing:0.3px;}' +
        '.pip-btn:hover{opacity:0.85;}' +
        '</style></head>' +
        '<body><div class="pip-wrap">' +
        '<div class="pip-cat">' + phaseLabel + '</div>' +
        '<div class="pip-time" id="pip-display">' + timeStr + '</div>' +
        '<button class="pip-btn" id="pip-startstop" style="background:' + btnBg + ';color:#0a0a0a;">' + btnLabel + '</button>' +
        '</div></body></html>';
}

function updatePipContent() {
    if (!pipWindow || pipWindow.closed) { stopPipInterval(); return; }
    var timeStr = document.getElementById('timerDisplay').textContent;
    var cat = getPipCatInfo();
    var isBreak = currentMode === 'pomodoro' && pomPhase === 'break';
    var accentColor = isBreak ? '#666666' : cat.color;
    var display = pipWindow.document.getElementById('pip-display');
    var btn = pipWindow.document.getElementById('pip-startstop');
    var catEl = pipWindow.document.querySelector('.pip-cat');
    if (!display) return;
    display.textContent = timeStr;
    display.style.color = running ? accentColor : '#f0f0f0';
    if (catEl) {
        catEl.style.color = accentColor;
        catEl.textContent = currentMode === 'pomodoro'
            ? (pomPhase === 'work' ? 'WORK — Cycle ' + (pomCyclesDone + 1) + '/' + pomTotalCycles : 'BREAK — Cycle ' + pomCyclesDone + '/' + pomTotalCycles)
            : cat.label;
    }
    if (btn) {
        btn.textContent = running ? '⏸ Stop' : '▶ Start';
        btn.style.background = running ? '#e05252' : accentColor;
    }
}

function startPipInterval() {
    if (pipInterval) clearInterval(pipInterval);
    pipInterval = setInterval(updatePipContent, 200);
}

function stopPipInterval() {
    if (pipInterval) { clearInterval(pipInterval); pipInterval = null; }
}

async function togglePip() {
    if (!window.documentPictureInPicture) {
        notify('Picture-in-Picture not supported in this browser. Use Chrome 116+.');
        return;
    }
    if (pipWindow && !pipWindow.closed) {
        pipWindow.close();
        pipWindow = null;
        stopPipInterval();
        document.getElementById('pipBtn').innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="11" width="9" height="7" rx="1.5" fill="currentColor" stroke="none" opacity="0.5"/></svg>PiP';
        return;
    }
    try {
        pipWindow = await window.documentPictureInPicture.requestWindow({ width: 240, height: 140 });
        var cat = getPipCatInfo();
        var timeStr = document.getElementById('timerDisplay').textContent;
        pipWindow.document.open();
        pipWindow.document.write(buildPipHTML(cat, timeStr));
        pipWindow.document.close();
        // Wire up the Start/Stop button to call toggleTimer on the main page
        pipWindow.document.getElementById('pip-startstop').addEventListener('click', function() {
            toggleTimer();
        });
        pipWindow.addEventListener('pagehide', function() {
            pipWindow = null;
            stopPipInterval();
            document.getElementById('pipBtn').innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="11" width="9" height="7" rx="1.5" fill="currentColor" stroke="none" opacity="0.5"/></svg>PiP';
        });
        startPipInterval();
        document.getElementById('pipBtn').innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="11" width="9" height="7" rx="1.5" fill="currentColor" stroke="none" opacity="0.5"/></svg>Close PiP';
    } catch(e) {
        notify('Could not open PiP window.');
    }
}

/* ── SLEEP DETECTION ── */
var SLEEP_THRESHOLD_MS = 15 * 60 * 1000; // 15 min gap = treat as sleep/hibernate
var lastTickTime = Date.now();

// Wrap tick to detect sleep gaps
var _origTick = tick;
tick = function() {
    var now = Date.now();
    var gap = now - lastTickTime;
    lastTickTime = now;
    if (running && !paused && gap > SLEEP_THRESHOLD_MS) {
        clearInterval(interval);
        running = false;
        var minsToSave = Math.round(elapsedMs / 60000);
        var gapMins = Math.round(gap / 60000);
        if (minsToSave > 0) {
            recordSession(currentCat, minsToSave);
            sendNotif('Auto-stopped after sleep', '+' + minsToHours(minsToSave) + ' saved. Device was asleep for ~' + gapMins + ' min.');
            addLogEntry('sleep', 'Device slept. Saved ' + minsToHours(minsToSave) + '. Gap of ~' + gapMins + ' min not counted.');
        } else {
            sendNotif('Timer auto-stopped', 'Device slept. Session too short to save.');
            addLogEntry('sleep', 'Device slept. Session too short to save.');
        }
        elapsedMs = 0; startTime = null;
        document.getElementById('startStopBtn').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
        document.getElementById('startStopBtn').style.background = 'var(--accent)';
        document.getElementById('timerDisplay').textContent = '00:00:00';
        document.getElementById('timerDisplay').classList.remove('running');
        if (currentMode === 'pomodoro') { document.getElementById('pomStatus').textContent = ''; }
        return;
    }
    _origTick();
};

// Also catch wakeup via visibilitychange (tab switch or screen unlock)
document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && running && !paused) {
        var gap = Date.now() - lastTickTime;
        if (gap > SLEEP_THRESHOLD_MS) {
            clearInterval(interval);
            running = false;
            var minsToSave = Math.round(elapsedMs / 60000);
            var gapMins = Math.round(gap / 60000);
            if (minsToSave > 0) {
                recordSession(currentCat, minsToSave);
                sendNotif('Auto-stopped after sleep', '+' + minsToHours(minsToSave) + ' saved. Device was away for ~' + gapMins + ' min.');
                addLogEntry('sleep', 'Device slept. Saved ' + minsToHours(minsToSave) + '. Gap of ~' + gapMins + ' min not counted.');
            } else {
                sendNotif('Timer auto-stopped', 'Device was away. Session too short to save.');
                addLogEntry('sleep', 'Device was away. Session too short to save.');
            }
            elapsedMs = 0; startTime = null;
            document.getElementById('startStopBtn').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
            document.getElementById('startStopBtn').style.background = 'var(--accent)';
            document.getElementById('timerDisplay').textContent = '00:00:00';
            document.getElementById('timerDisplay').classList.remove('running');
            if (currentMode === 'pomodoro') { document.getElementById('pomStatus').textContent = ''; }
        }
    }
    lastTickTime = Date.now();
});

function init(){
    loadDB(); updateHeaderClock(); setInterval(updateHeaderClock,1000);
    renderAimRows(); loadAims(); renderCatBtns(); applyTheme(currentCat); renderProgress(); updateStreak(); buildDaySelector();
    renderCatManageList(); populateManualCatSelect();
    loadActivityLog(); renderActivityLog();
    setInterval(function(){
        checkCatSwitch();
        checkMidnightLogReset();
    },60000);
    // Request notification permission early so timer-complete notifs work
    if('Notification' in window && Notification.permission === 'default'){
        Notification.requestPermission();
    }
    // Set default date on manual session input to today
    var manualDateEl = document.getElementById('manualDate');
    if (manualDateEl) manualDateEl.value = getTodayKey();
}
init();
