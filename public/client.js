const socket = io();

const authDiv       = document.getElementById('auth');
const menuDiv       = document.getElementById('menu');
const canvas        = document.getElementById('gameCanvas');
const ctx           = canvas.getContext('2d');
const authStatus    = document.getElementById('auth-status');
const chatContainer = document.getElementById('chat-container');
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const mmOverlay     = document.getElementById('matchmaking-overlay');
const mmText        = document.getElementById('mm-text');
const eloDisplay    = document.getElementById('my-elo-display');
const afkScreen     = document.getElementById('afk-screen');

let myId, myUsername = '', myElo = 1000, myCharacter = 'korzhik', mySelectedMode = 1, currentRoom = null, myTeam = null, isSpectator = false;

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const myDeviceIcon = isMobileDevice ? '📱' : '💻';

const PLAYER_RADIUS = 40, PUCK_RADIUS = 20;

const images = {
    rink: new Image(), puck: new Image(), korzhik: new Image(), karamelka: new Image(), kompot: new Image(), gonya: new Image(),
    goal_korzhik: new Image(), goal_karamelka: new Image(), goal_kompot: new Image(), goal_gonya: new Image()
};
images.rink.src = 'assets/rink.jpg'; images.puck.src = 'assets/puck.png';
images.korzhik.src = 'assets/korzhik.png'; images.karamelka.src = 'assets/karamelka.png';
images.kompot.src = 'assets/kompot.png'; images.gonya.src = 'assets/gonya.png';
images.goal_korzhik.src = 'assets/kor_gol.png'; images.goal_karamelka.src = 'assets/car_gol.png';
images.goal_kompot.src = 'assets/kom_gol.png'; images.goal_gonya.src = 'assets/gon_gol.png';

const hitSounds = [new Audio('assets/shay1.mp3'), new Audio('assets/shay2.mp3')];
const startSound = new Audio('assets/start.mp3');

// === РОЗБЛОКУВАННЯ ЗВУКУ ТА WEB AUDIO ===
let audioUnlocked = false;
let audioCtx = null; // Web Audio API контекст для голосу

function initAudioContext() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Відтворимо порожній звук, щоб контекст став активним
    const silent = audioCtx.createBufferSource();
    silent.buffer = audioCtx.createBuffer(1, 1, 22050);
    silent.connect(audioCtx.destination);
    silent.start();
}

const unlockAudio = function() {
    if (!audioUnlocked) {
        startSound.play().then(() => { startSound.pause(); startSound.currentTime = 0; }).catch(() => {});
        hitSounds.forEach(snd => { snd.play().then(() => { snd.pause(); snd.currentTime = 0; }).catch(() => {}); });
        initAudioContext();
        audioUnlocked = true;
        document.removeEventListener('touchstart', unlockAudio);
        document.removeEventListener('mousedown', unlockAudio);
    }
};
document.addEventListener('touchstart', unlockAudio, { passive: true });
document.addEventListener('mousedown', unlockAudio, { passive: true });

function safePlaySound(audioElement) { try { const p = audioElement.play(); if (p !== undefined) p.catch(e => {}); } catch (e) {} }

const charColors = { korzhik: '0, 100, 255', karamelka: '255, 105, 180', kompot: '0, 200, 0', gonya: '255, 165, 0' };
let gameState = { players: {}, puck: { x: 600, y: 300, rotation: 0 }, score: { team1: 0, team2: 0 }, timeLeft: 180 };
let isDragging = false, showGoalAnimation = false, goalScorerChar = null, goalAnimationStart = 0, floatingTexts = [];

document.addEventListener('touchmove', function(e) { if (e.target.tagName !== 'INPUT') e.preventDefault(); }, { passive: false });

function enableFullscreen() {
    try { const elem = document.documentElement; if (elem.requestFullscreen) elem.requestFullscreen(); else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen(); } catch(e) {}
}

socket.on('onlineCount', (count) => { document.getElementById('online-counter').innerText = `Онлайн: ${count}`; });
socket.on('pingTimer', (ts) => { socket.emit('pongTimer', ts); });

function register() { const u = document.getElementById('username').value.trim(), p = document.getElementById('password').value.trim(); if (u && p) socket.emit('register', { username: u, password: p }); }
function login() { const u = document.getElementById('username').value.trim(), p = document.getElementById('password').value.trim(); if (u && p) socket.emit('login', { username: u, password: p }); }
function manualAutoLogin() { try { const id = localStorage.getItem('userId'); if (id) socket.emit('autoLogin', id); } catch(e) {} }

window.onload = () => { try { if (localStorage.getItem('userId')) document.getElementById('btn-autologin').style.display = 'inline-block'; } catch(e) {} };

socket.on('authResult', (res) => {
    if (res.success) {
        myId = res.userId; myUsername = res.username; myElo = res.elo;
        try { localStorage.setItem('userId', myId); } catch(e) {}
        authDiv.style.display = 'none'; menuDiv.style.display = 'block';
        document.getElementById('welcome-text').innerText = `Привет, ${myUsername}!`;
        if (eloDisplay) eloDisplay.innerText = `🏆 Рейтинг Эло: ${myElo}`;
    } else { authStatus.innerText = res.msg || 'Ошибка'; authStatus.style.color = 'red'; }
});

function selectCharacter(char) { myCharacter = char; document.querySelectorAll('.char-btn').forEach(b => b.classList.remove('active-btn')); document.getElementById(`btn-${char}`).classList.add('active-btn'); }
function selectMode(mode) { mySelectedMode = mode; document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active-btn')); document.getElementById(`btn-mode-${mode}`).classList.add('active-btn'); }

function startMatchmaking() { enableFullscreen(); mmOverlay.style.display = 'flex'; mmText.innerText = `Ищем игру ${mySelectedMode} на ${mySelectedMode}...`; socket.emit('findMatch', { character: myCharacter, username: myUsername, mode: mySelectedMode, device: myDeviceIcon }); }
function cancelMatchmaking() { socket.emit('cancelMatchMatchmaking'); mmOverlay.style.display = 'none'; }
function spectateRandomGame() { enableFullscreen(); socket.emit('spectateRandom'); }

function enterGame(roomId, state, spectator) {
    isSpectator = spectator; currentRoom = roomId; gameState = state;
    if (!spectator && gameState.players[socket.id]) myTeam = gameState.players[socket.id].team;
    
    mmOverlay.style.display = 'none'; menuDiv.style.display = 'none'; canvas.style.display = 'block';
    chatContainer.style.display = 'flex'; if (chatToggleBtn) chatToggleBtn.style.display = 'flex';
    
    if (mediaRecorder) { const pttBtn = document.getElementById('ptt-btn'); if (pttBtn) pttBtn.style.display = 'block'; }
    wakeUpChat(); startSound.currentTime = 0; safePlaySound(startSound); requestAnimationFrame(gameLoop);
}

socket.on('waiting', (msg) => { mmText.innerText = msg; });
socket.on('matchFound', (data) => { enterGame(data.roomId, data.state, false); });
socket.on('spectateStart', (data) => { enterGame(data.roomId, data.state, true); alert('Вы подключились как зритель! 👁️'); });
socket.on('afkWarning', () => { isSpectator = true; if (afkScreen) afkScreen.style.display = 'flex'; });

socket.on('gs', (miniState) => {
    if (!currentRoom) return;
    gameState.puck.targetX = miniState.u.x; gameState.puck.targetY = miniState.u.y; gameState.puck.targetR = miniState.u.r;
    gameState.score = miniState.s; gameState.timeLeft = miniState.t;

    for (const id in miniState.p) {
        if (!gameState.players[id]) gameState.players[id] = { x: miniState.p[id].x, y: miniState.p[id].y, rotation: 0 };
        gameState.players[id].targetX = miniState.p[id].x; gameState.players[id].targetY = miniState.p[id].y;
        gameState.players[id].targetR = miniState.p[id].r; gameState.players[id].ping = miniState.p[id].ping;
        gameState.players[id].isBot = miniState.p[id].isBot; gameState.players[id].device = miniState.p[id].d; 
    }
    if (miniState.h === 1) { const snd = hitSounds[Math.floor(Math.random() * hitSounds.length)]; snd.currentTime = 0; safePlaySound(snd); }
});

socket.on('goal', (char) => {
    goalScorerChar = char; showGoalAnimation = true; goalAnimationStart = performance.now();
    setTimeout(() => { startSound.currentTime = 0; safePlaySound(startSound); }, 2500);
});

let eloChangeMsg = '';
socket.on('eloUpdated', (data) => {
    myElo = data.elo; if (eloDisplay) eloDisplay.innerText = `🏆 Рейтинг Эло: ${myElo}`;
    if (data.change > 0 && gameState.players[socket.id] && canvas.style.display === 'block') {
        floatingTexts.push({ x: gameState.players[socket.id].x, y: gameState.players[socket.id].y - 60, text: `+${data.change} ЭЛО!`, life: 90 });
    }
    if (data.change !== 25 && data.change !== 10) eloChangeMsg = `\nЭло за матч: ${data.change > 0 ? '+' : ''}${data.change} (Всего: ${myElo})`;
});

socket.on('gameOver', (finalScore) => {
    let msg = 'Матч окончен!';
    if (!isSpectator && afkScreen.style.display !== 'flex') {
        if      (myTeam === 1 && finalScore.team1 > finalScore.team2) msg = 'ВЫ ПОБЕДИЛИ! 🎉';
        else if (myTeam === 1 && finalScore.team1 < finalScore.team2) msg = 'ВЫ ПРОИГРАЛИ! 😭';
        else if (myTeam === 2 && finalScore.team2 > finalScore.team1) msg = 'ВЫ ПОБЕДИЛИ! 🎉';
        else if (myTeam === 2 && finalScore.team2 < finalScore.team1) msg = 'ВЫ ПРОИГРАЛИ! 😭';
        else msg = 'Ничья!';
    }
    const pttBtn = document.getElementById('ptt-btn'); if (pttBtn) pttBtn.style.display = 'none';
    setTimeout(() => { alert(`${msg}\nИтоговый счет: ${finalScore.team1} : ${finalScore.team2}${eloChangeMsg}`); location.reload(); }, 500);
});

let chatTimeout;
function toggleChat() {
    if (chatContainer.style.display === 'none') { chatContainer.style.display = 'flex'; chatToggleBtn.innerText = '👁️'; chatToggleBtn.classList.remove('chat-hidden'); wakeUpChat(); }
    else { chatContainer.style.display = 'none'; chatToggleBtn.innerText = '🙈'; chatToggleBtn.classList.add('chat-hidden'); }
}
function wakeUpChat() {
    if (chatContainer.style.display === 'none') return;
    chatContainer.style.opacity = '1'; clearTimeout(chatTimeout);
    chatTimeout = setTimeout(() => { if (document.activeElement !== document.getElementById('chat-input')) chatContainer.style.opacity = '0.3'; }, 4000);
}
document.getElementById('chat-input').addEventListener('focus', () => { chatContainer.style.opacity = '1'; clearTimeout(chatTimeout); });
document.getElementById('chat-input').addEventListener('blur', wakeUpChat);
function sendChat() { const t = document.getElementById('chat-input').value.trim(); if (t && currentRoom) { socket.emit('chatMessage', { roomId: currentRoom, sender: isSpectator ? `[Зритель] ${myUsername}` : myUsername, text: t }); document.getElementById('chat-input').value = ''; } }
document.getElementById('chat-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });
socket.on('chatMessage', (data) => { if (chatContainer.style.display !== 'none') wakeUpChat(); const msgs = document.getElementById('chat-messages'); msgs.innerHTML += `<div><b>${data.sender}:</b> ${data.text}</div>`; msgs.scrollTop = msgs.scrollHeight; });

function getEventPos(e) {
    const rect = canvas.getBoundingClientRect(), scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    let clientX = e.clientX, clientY = e.clientY;
    if (e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}
function sendInput(pos, dragging) { if (isSpectator || !currentRoom) return; socket.emit('input', { roomId: currentRoom, dragging, tx: pos ? pos.x : null, ty: pos ? pos.y : null }); }
function handleStart(e) {
    if (isSpectator || e.target.closest('#chat-container') || e.target.closest('#chat-toggle-btn') || e.target.closest('#ptt-btn')) return;
    const pos = getEventPos(e), myPlayer = gameState.players[socket.id]; if (!myPlayer) return;
    const dx = pos.x - myPlayer.x, dy = pos.y - myPlayer.y;
    if (Math.sqrt(dx*dx + dy*dy) <= PLAYER_RADIUS * 1.5) { isDragging = true; sendInput(pos, true); }
}
function handleEnd() { if (isDragging) { isDragging = false; sendInput(null, false); } }
function handleMove(e) { if (!isDragging) return; if (e.cancelable) e.preventDefault(); sendInput(getEventPos(e), true); }

canvas.addEventListener('mousedown', handleStart); window.addEventListener('mouseup', handleEnd); canvas.addEventListener('mousemove', handleMove);
canvas.addEventListener('touchstart', handleStart, { passive: false }); window.addEventListener('touchend', handleEnd); canvas.addEventListener('touchmove', handleMove, { passive: false });

function safeDrawCircleImage(img, x, y, radius, rot = 0) {
    if (!img.complete || img.naturalWidth === 0) { ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = 'gray'; ctx.fill(); return; }
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
    ctx.drawImage(img, -radius, -radius, radius * 2, radius * 2); ctx.restore();
}

function gameLoop(timestamp) {
    if (!currentRoom) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (images.rink.complete) ctx.drawImage(images.rink, 0, 0, canvas.width, canvas.height);

    if (gameState.puck.targetX !== undefined) {
        gameState.puck.x += (gameState.puck.targetX - gameState.puck.x) * 0.4; gameState.puck.y += (gameState.puck.targetY - gameState.puck.y) * 0.4; gameState.puck.rotation += (gameState.puck.targetR - (gameState.puck.rotation || 0)) * 0.4;
    }
    safeDrawCircleImage(images.puck, gameState.puck.x, gameState.puck.y, PUCK_RADIUS, gameState.puck.rotation);

    for (const id in gameState.players) {
        const p = gameState.players[id];
        if (p.targetX !== undefined) { p.x += (p.targetX - p.x) * 0.4; p.y += (p.targetY - p.y) * 0.4; p.rotation += (p.targetR - (p.rotation || 0)) * 0.4; }
        safeDrawCircleImage(images[p.char] || images.korzhik, p.x, p.y, PLAYER_RADIUS, p.rotation);
        
        ctx.save(); ctx.translate(p.x, p.y); ctx.textAlign = 'center'; ctx.fillStyle = (id === socket.id && !isSpectator) ? '#ffd700' : 'white'; ctx.font = '14px Arial';
        ctx.fillText(p.isBot ? `[BOT] ${p.username}` : `${p.device || '💻'} ${p.username}`, 0, -PLAYER_RADIUS - 15);
        const ping = p.ping || 0; ctx.fillStyle = ping > 150 ? '#ff4d4d' : (ping > 80 ? '#ffd633' : '#00ff00'); ctx.font = 'bold 12px Arial'; ctx.fillText(`${ping} ms`, 0, -PLAYER_RADIUS - 2); ctx.restore();
    }

    ctx.fillStyle = 'white'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center'; ctx.fillText(`${gameState.score.team1} : ${gameState.score.team2}`, canvas.width / 2, 50);
    const min = Math.floor(gameState.timeLeft / 60), sec = gameState.timeLeft % 60; ctx.fillStyle = gameState.timeLeft <= 10 ? 'red' : 'yellow'; ctx.font = 'bold 24px Arial'; ctx.fillText(`⏱ ${min}:${sec < 10 ? '0' : ''}${sec}`, canvas.width / 2, 85);

    if (showGoalAnimation) {
        const elapsed = timestamp - goalAnimationStart; let opacity = Math.min(elapsed / 500, 0.6); if (elapsed > 2000) opacity = Math.max(0, 0.6 - (elapsed - 2000) / 500); if (elapsed > 2500) showGoalAnimation = false;
        ctx.fillStyle = `rgba(${charColors[goalScorerChar] || '255, 255, 255'}, ${opacity})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const goalImg = images[`goal_${goalScorerChar}`] || images.goal_korzhik;
        if (goalImg.complete) { ctx.globalAlpha = opacity / 0.6; ctx.drawImage(goalImg, canvas.width / 2 - 150, canvas.height / 2 - 150, 300, 300); ctx.globalAlpha = 1.0; }
    }

    for (let i = 0; i < floatingTexts.length; i++) {
        const ft = floatingTexts[i]; ctx.fillStyle = `rgba(255, 215, 0, ${ft.life / 90})`; ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center';
        ctx.shadowColor = 'black'; ctx.shadowBlur = 4; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2; ctx.fillText(ft.text, ft.x, ft.y); ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ft.y -= 1; ft.life--;
    }
    floatingTexts = floatingTexts.filter(ft => ft.life > 0); requestAnimationFrame(gameLoop);
}

// ========== ГОЛОСОВИЙ ЧАТ З ТРАНСКРИПЦІЄЮ ТА PITCH SHIFT ==========
let mediaRecorder = null, audioChunks = [], isRecording = false, recorderMimeType = '';
let recognition = null; // для Web Speech API
let pitchShiftSemitones = 0; // значення від -12 до 12

// Функція pitch shift: змінює висоту тону аудіобуфера (зберігаючи тривалість)
async function applyPitchShift(audioBuffer, semitones) {
    if (semitones === 0) return audioBuffer;
    const factor = Math.pow(2, semitones / 12); // pitch shift factor (>1 = вище)
    const originalSampleRate = audioBuffer.sampleRate;
    const newSampleRate = originalSampleRate * factor;
    const numberOfChannels = audioBuffer.numberOfChannels;
    const originalLength = audioBuffer.length;
    const newLength = Math.round(originalLength / factor);
    
    // Створюємо новий буфер зі зміненою частотою дискретизації
    const offlineCtx = new OfflineAudioContext(numberOfChannels, newLength, newSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const renderedBuffer = await offlineCtx.startRendering();
    
    // Тепер маємо буфер з pitch shift, але іншої тривалості.
    // Щоб повернути оригінальну тривалість, робимо ресемплінг до початкового sampleRate.
    if (newSampleRate === originalSampleRate) return renderedBuffer;
    
    const finalLength = Math.round(renderedBuffer.length * originalSampleRate / newSampleRate);
    const finalBuffer = audioCtx.createBuffer(numberOfChannels, finalLength, originalSampleRate);
    for (let ch = 0; ch < numberOfChannels; ch++) {
        const srcData = renderedBuffer.getChannelData(ch);
        const dstData = finalBuffer.getChannelData(ch);
        const ratio = renderedBuffer.length / finalLength;
        for (let i = 0; i < finalLength; i++) {
            const srcIndex = i * ratio;
            const indexFloor = Math.floor(srcIndex);
            const indexCeil = Math.min(indexFloor + 1, renderedBuffer.length - 1);
            const frac = srcIndex - indexFloor;
            dstData[i] = srcData[indexFloor] * (1 - frac) + srcData[indexCeil] * frac;
        }
    }
    return finalBuffer;
}

async function initWalkieTalkie() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        recorderMimeType = mediaRecorder.mimeType; 

        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
            if (audioChunks.length === 0 || !currentRoom) return;
            
            // Спочатку транскрипція (якщо була)
            let transcript = '';
            if (recognition && recognition.result) {
                transcript = recognition.result;
            }
            
            // Отримуємо аудіо Blob
            let audioBlob = new Blob(audioChunks, { type: recorderMimeType });
            // Застосовуємо pitch shift, якщо потрібно
            if (pitchShiftSemitones !== 0 && audioCtx) {
                try {
                    const arrayBuffer = await audioBlob.arrayBuffer();
                    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                    const shiftedBuffer = await applyPitchShift(audioBuffer, pitchShiftSemitones);
                    // Конвертуємо AudioBuffer назад у Blob
                    const wavBlob = await audioBufferToWav(shiftedBuffer);
                    audioBlob = wavBlob;
                } catch(e) { console.error("Pitch shift failed", e); }
            }
            
            const arrayBuffer = await audioBlob.arrayBuffer();
            socket.emit('voice-message', { 
                roomId: currentRoom, 
                sender: myUsername, 
                audioBlob: arrayBuffer, 
                mimeType: audioBlob.type,
                transcript: transcript 
            });
            audioChunks = [];
            
            // Додаємо своє повідомлення в чат (тільки текст)
            addChatMessage(`🔊 Вы (${transcript || 'голосовое сообщение'})`);
        };

        document.getElementById('btn-enable-mic').style.display = 'none';
        document.getElementById('mic-status').innerText = "✅ Микрофон готов! В игре жми 'V'";
        document.getElementById('mic-status').style.color = "#4dff4d";
        
        // Показати елементи керування pitch
        const pitchDiv = document.getElementById('pitch-control');
        if (pitchDiv) pitchDiv.style.display = 'block';
        const pitchSlider = document.getElementById('pitch-slider');
        const pitchValue = document.getElementById('pitch-value');
        const pitchReset = document.getElementById('pitch-reset');
        if (pitchSlider) {
            pitchSlider.addEventListener('input', (e) => {
                pitchShiftSemitones = parseInt(e.target.value, 10);
                pitchValue.innerText = pitchShiftSemitones;
            });
        }
        if (pitchReset) {
            pitchReset.addEventListener('click', () => {
                pitchShiftSemitones = 0;
                pitchSlider.value = 0;
                pitchValue.innerText = 0;
            });
        }
        
        initAudioContext();
    } catch (err) {
        document.getElementById('mic-status').innerText = "❌ Доступ запрещен или нет микрофона";
        document.getElementById('mic-status').style.color = "#ff4d4d";
    }
}

// Допоміжна функція для конвертації AudioBuffer у WAV Blob (щоб зберегти тип)
function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    
    const samples = [];
    for (let ch = 0; ch < numChannels; ch++) {
        samples.push(buffer.getChannelData(ch));
    }
    
    const dataLength = samples[0].length * numChannels * bytesPerSample;
    const bufferLength = 44 + dataLength;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);
    
    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }
    
    writeString(view, 0, 'RIFF');
    view.setUint32(4, bufferLength - 8, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);
    
    let offset = 44;
    for (let i = 0; i < samples[0].length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, samples[ch][i]));
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset, intSample, true);
            offset += 2;
        }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function startRecording() {
    if (!mediaRecorder || isRecording) return;
    isRecording = true;
    audioChunks = [];
    mediaRecorder.start();
    const btn = document.getElementById('ptt-btn'); 
    if(btn) { btn.style.backgroundColor = "rgba(255, 0, 0, 0.8)"; btn.innerText = "🔴 Запись..."; }
    
    // Запускаємо транскрипцію, якщо підтримується Web Speech API
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.lang = 'ru-RU';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.onresult = (event) => {
            if (event.results.length > 0) {
                recognition.result = event.results[0][0].transcript;
            }
        };
        recognition.onerror = (e) => { console.warn("Speech recognition error", e); };
        recognition.start();
    } else {
        recognition = null;
    }
}

function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    isRecording = false;
    setTimeout(() => { mediaRecorder.stop(); }, 100);
    if (recognition) {
        recognition.stop();
    }
    const btn = document.getElementById('ptt-btn'); 
    if(btn) { btn.style.backgroundColor = "rgba(0, 51, 102, 0.8)"; btn.innerText = "🎙️ Удерживай (или жми 'V')"; }
}

document.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'v' && !e.repeat && currentRoom) startRecording(); });
document.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'v' && currentRoom) stopRecording(); });

// Функція додавання повідомлення в чат
function addChatMessage(text) {
    const msgs = document.getElementById('chat-messages');
    if (!msgs) return;
    msgs.innerHTML += `<div>${text}</div>`;
    msgs.scrollTop = msgs.scrollHeight;
    wakeUpChat();
}

// Оновлений обробник голосових повідомлень (Web Audio + чат)
socket.on('voice-message', (data) => {
    try {
        if (!audioCtx) return;
        // Додаємо повідомлення в чат
        const transcriptMsg = data.transcript ? `: "${data.transcript}"` : '';
        addChatMessage(`🔊 ${data.sender}${transcriptMsg}`);
        
        const arrayBuffer = data.audioBlob;
        audioCtx.decodeAudioData(arrayBuffer, (buffer) => {
            const source = audioCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(audioCtx.destination);
            source.start(0);
        }, (err) => {
            console.error('Помилка декодування аудіо:', err);
        });
    } catch (e) {
        console.error('Помилка відтворення голосу:', e);
    }
});
