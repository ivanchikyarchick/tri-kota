const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000, pingInterval: 25000 });

app.use(express.static('public'));

// ============================================================
// КОНСТАНТИ
// ============================================================
const WIDTH         = 1200;
const HEIGHT        = 600;
const PLAYER_RADIUS = 40;
const PUCK_RADIUS   = 20;
const FRICTION      = 0.985;
const GOAL_HEIGHT   = 150;
const WALL_PADDING  = 25;
const MAX_PUCK_SPEED = 35;

// ============================================================
// СТАН СЕРВЕРА
// ============================================================
const usersDb       = {};   // { username: { password, elo } }
const rooms         = {};   // { roomId: { state, players, endTime, eloAwarded, loopInterval } }
const queues        = { 1: [], 2: [], 3: [] };
const ipConnections = {};
const playerStats   = {};   // адаптивна статистика гравців
let totalOnline     = 0;

// ============================================================
// ІГРОВИЙ СТАН
// ============================================================
function initGameState() {
    return {
        players: {},
        puck: { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, vr: 0, rotation: 0, lastHit: null },
        score: { team1: 0, team2: 0 },
        goalTriggered: false,
    };
}

// ============================================================
// ФІЗИКА
// ============================================================
function applyPhysics(obj1, obj2, r1, r2, mass1, mass2, bounciness) {
    if (!obj1 || !obj2 || isNaN(obj1.x) || isNaN(obj2.x)) return false;

    let dx = obj2.x - obj1.x;
    let dy = obj2.y - obj1.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) { dx = 0.1; dist = 0.1; }
    const minDist = r1 + r2;

    if (dist < minDist) {
        const overlap    = minDist - dist;
        const nx         = dx / dist;
        const ny         = dy / dist;
        const totalMass  = mass1 + mass2;

        obj1.x -= nx * overlap * (mass2 / totalMass);
        obj1.y -= ny * overlap * (mass2 / totalMass);
        obj2.x += nx * overlap * (mass1 / totalMass);
        obj2.y += ny * overlap * (mass1 / totalMass);

        obj1.vx = obj1.vx || 0; obj1.vy = obj1.vy || 0; obj1.vr = obj1.vr || 0;
        obj2.vx = obj2.vx || 0; obj2.vy = obj2.vy || 0; obj2.vr = obj2.vr || 0;

        const kx = obj1.vx - obj2.vx;
        const ky = obj1.vy - obj2.vy;
        const p  = 2 * (nx * kx + ny * ky) / totalMass;

        obj1.vx -= p * mass2 * bounciness * nx;
        obj1.vy -= p * mass2 * bounciness * ny;
        obj2.vx += p * mass1 * bounciness * nx;
        obj2.vy += p * mass1 * bounciness * ny;

        const tangent = -nx * ky + ny * kx;
        obj1.vr += tangent * 0.4 * (mass2 / totalMass);
        obj2.vr -= tangent * 0.4 * (mass1 / totalMass);

        return true;
    }
    return false;
}

// ============================================================
// ШІ — ПЕРЕДБАЧЕННЯ ТРАЄКТОРІЇ ШАЙБИ
// ============================================================
function predictPuckPosition(puck, steps) {
    let x = puck.x, y = puck.y, vx = puck.vx, vy = puck.vy;
    for (let i = 0; i < steps; i++) {
        x += vx; y += vy;
        vx *= FRICTION; vy *= FRICTION;
        if (y - PUCK_RADIUS < WALL_PADDING)              { y = PUCK_RADIUS + WALL_PADDING;              vy *= -0.9; }
        else if (y + PUCK_RADIUS > HEIGHT - WALL_PADDING){ y = HEIGHT - PUCK_RADIUS - WALL_PADDING;     vy *= -0.9; }
        if (x - PUCK_RADIUS < WALL_PADDING)              { x = PUCK_RADIUS + WALL_PADDING;              vx *= -0.9; }
        else if (x + PUCK_RADIUS > WIDTH - WALL_PADDING) { x = WIDTH - PUCK_RADIUS - WALL_PADDING;      vx *= -0.9; }
    }
    return { x, y };
}

// ============================================================
// ШІ — ВІДСТЕЖЕННЯ ПОВЕДІНКИ ГРАВЦЯ
// ============================================================
function trackPlayerBehavior(roomId, playerId) {
    if (!playerStats[playerId]) {
        playerStats[playerId] = {
            rushCount:   0,
            prefersTop:  0,
            lastX:       null,
            lastY:       null,
        };
    }
    const game = rooms[roomId];
    if (!game) return;
    const p = game.state.players[playerId];
    if (!p || p.isBot) return;

    const stats = playerStats[playerId];
    if (stats.lastX !== null) {
        const dx = p.x - stats.lastX;
        if (Math.abs(dx) > 2) stats.rushCount++;
        stats.prefersTop += (p.y < HEIGHT / 2) ? 1 : -1;
    }
    stats.lastX = p.x;
    stats.lastY = p.y;
}

// ============================================================
// ШІ — РІВЕНЬ АДАПТАЦІЇ ДО ГРАВЦЯ
// ============================================================
function getAdaptiveLevel(playerId) {
    const stats = playerStats[playerId];
    if (!stats) return { reactionSteps: 15, jitter: 12, aggressionMult: 1.0, prefersTop: 0 };

    const rushScore = Math.min(stats.rushCount / 60, 1); // 0..1
    return {
        reactionSteps:  Math.round(15 - rushScore * 8),   // 15→7 кадрів
        jitter:         Math.round(12 - rushScore * 8),   // 12→4 рандом
        aggressionMult: 1 + rushScore * 0.6,              // 1.0→1.6x
        prefersTop:     stats.prefersTop,
    };
}

// ============================================================
// ШІ — ГОЛОВНА ЛОГІКА РІШЕНЬ БОТА
// ============================================================
function getBotDecision(p, puck, teammates, enemies, remainingSeconds, score, enemyIds) {
    const isTeam1   = p.team === 1;
    const myGoalX   = isTeam1 ? WALL_PADDING + 30       : WIDTH - WALL_PADDING - 30;
    const eneGoalX  = isTeam1 ? WIDTH - WALL_PADDING - 30 : WALL_PADDING + 30;
    const goalY     = HEIGHT / 2;

    const myScore    = isTeam1 ? score.team1 : score.team2;
    const enemyScore = isTeam1 ? score.team2 : score.team1;
    const losing     = myScore < enemyScore;
    const lastMinute = remainingSeconds < 60;

    // Найбільш активний ворог задає темп адаптації
    let adaptLevel = { reactionSteps: 15, jitter: 12, aggressionMult: 1.0, prefersTop: 0 };
    for (const eid of enemyIds) {
        const lvl = getAdaptiveLevel(eid);
        if (lvl.reactionSteps < adaptLevel.reactionSteps) adaptLevel = lvl;
    }

    const predicted  = predictPuckPosition(puck, adaptLevel.reactionSteps);
    const predicted8 = predictPuckPosition(puck, 8);

    const puckDistToMyGoal   = Math.abs(puck.x - myGoalX);
    const puckMovingToMyGoal = isTeam1 ? puck.vx < -1.5 : puck.vx > 1.5;
    const puckSpeed          = Math.sqrt(puck.vx ** 2 + puck.vy ** 2);
    const puckOnOurSide      = isTeam1 ? puck.x < WIDTH * 0.5 : puck.x > WIDTH * 0.5;

    const defenders = teammates.filter(t => isTeam1 ? t.x < WIDTH * 0.45 : t.x > WIDTH * 0.55).length;
    const attackers = teammates.length - defenders;

    // ── РЕЖИМ 1: ЕКСТРЕНИЙ БЛОК ВОРІТ ────────────────────────────────
    if (puckMovingToMyGoal && puckDistToMyGoal < 250) {
        const gkX     = myGoalX + (isTeam1 ? 55 : -55);
        const clampedY = Math.max(
            goalY - GOAL_HEIGHT / 2 + PLAYER_RADIUS,
            Math.min(goalY + GOAL_HEIGHT / 2 - PLAYER_RADIUS, predicted8.y)
        );
        return { tx: gkX, ty: clampedY, mode: 'emergency_block' };
    }

    // ── РЕЖИМ 2: СТРАТЕГІЧНИЙ ЗАХИСТ ЗОНИ ────────────────────────────
    if (puckOnOurSide && defenders === 0) {
        const defX = myGoalX + (isTeam1 ? 120 : -120);
        let defY   = predicted.y;

        // Адаптуємось до звички гравця
        if (Math.abs(adaptLevel.prefersTop) > 10) {
            defY += adaptLevel.prefersTop > 0 ? -20 : 20;
        }
        defY = Math.max(WALL_PADDING + PLAYER_RADIUS, Math.min(HEIGHT - WALL_PADDING - PLAYER_RADIUS, defY));
        return { tx: defX, ty: defY, mode: 'strategic_defense' };
    }

    // ── РЕЖИМ 3: ПЕРЕХОПЛЕННЯ ─────────────────────────────────────────
    if (puckSpeed < 6 && puckOnOurSide) {
        return { tx: predicted.x, ty: predicted.y, mode: 'intercept' };
    }

    // ── РЕЖИМ 4: ПРИЦІЛЬНА АТАКА ──────────────────────────────────────
    if (!puckOnOurSide || (losing && lastMinute)) {
        // Б'ємо у вільний кут — аналізуємо де стоять вороги
        let targetY = goalY;
        if (enemies.length > 0) {
            const nearestEnemy = enemies.reduce((a, b) =>
                Math.abs(a.y - goalY) < Math.abs(b.y - goalY) ? a : b
            );
            targetY = nearestEnemy.y > goalY
                ? goalY - GOAL_HEIGHT * 0.35
                : goalY + GOAL_HEIGHT * 0.35;
        }

        const offsetX  = (PLAYER_RADIUS + PUCK_RADIUS + 8) * (isTeam1 ? -1 : 1);
        const approachX = predicted.x + offsetX;

        const aimDX  = eneGoalX - predicted.x;
        const aimDY  = targetY  - predicted.y;
        const aimLen = Math.sqrt(aimDX ** 2 + aimDY ** 2) || 1;

        return {
            tx:   approachX,
            ty:   predicted.y - (aimDY / aimLen) * 15 * adaptLevel.aggressionMult,
            mode: 'aimed_attack',
        };
    }

    // ── РЕЖИМ 5: СТРАТЕГІЧНЕ ПОЗИЦІЮВАННЯ ────────────────────────────
    const holdX = attackers > 0
        ? myGoalX + (isTeam1 ? 150 : -150)
        : (isTeam1
            ? Math.min(WIDTH * 0.4, puck.x - 80)
            : Math.max(WIDTH * 0.6, puck.x + 80));

    const holdY = goalY + (puck.y - goalY) * 0.45;
    return { tx: holdX, ty: holdY, mode: 'positioning' };
}

// ============================================================
// ГОЛИ ТА СКИДАННЯ
// ============================================================
function resetAfterGoal(roomId, scorerChar) {
    const game = rooms[roomId];
    if (!game) return;
    io.to(roomId).emit('goal', scorerChar);

    setTimeout(() => {
        if (!game || !game.state) return;
        game.state.puck = { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, vr: 0, rotation: 0, lastHit: null };
        game.state.goalTriggered = false;
        let t1Count = 0, t2Count = 0;
        for (const id in game.state.players) {
            const p = game.state.players[id];
            p.vx = 0; p.vy = 0; p.vr = 0; p.isDragging = false;
            if (p.team === 1) { p.x = 150 + t1Count * 50; p.y = 300 + t1Count * 50; t1Count++; }
            else              { p.x = 1050 - t2Count * 50; p.y = 300 + t2Count * 50; t2Count++; }
        }
    }, 2500);
}

function giveInstantElo(roomId, scoringTeam, lastHitId) {
    const game = rooms[roomId];
    if (!game) return;
    for (const id in game.state.players) {
        const p      = game.state.players[id];
        const dbUser = usersDb[p.username];
        if (!dbUser || p.isBot) continue;
        if (id === lastHitId && p.team === scoringTeam) {
            dbUser.elo += 25;
            io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: 25, reason: 'ГОЛ!' });
        } else if (p.team === scoringTeam) {
            dbUser.elo += 10;
            io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: 10, reason: 'КОМАНДА' });
        }
    }
}

function updateElo(roomId, finalScore) {
    const game = rooms[roomId];
    if (!game || game.eloAwarded) return;
    game.eloAwarded = true;
    for (const id in game.state.players) {
        const p      = game.state.players[id];
        const dbUser = usersDb[p.username];
        if (!dbUser || p.isBot) continue;
        let eloChange = 0;
        if (finalScore.team1 === finalScore.team2) {
            eloChange = 0;
        } else if (
            (p.team === 1 && finalScore.team1 > finalScore.team2) ||
            (p.team === 2 && finalScore.team2 > finalScore.team1)
        ) {
            eloChange = +15;
        } else {
            eloChange = -15;
        }
        dbUser.elo += eloChange;
        if (dbUser.elo < 0) dbUser.elo = 0;
        io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: eloChange });
    }
    // Очищаємо статистику адаптації після матчу
    for (const id in game.state.players) delete playerStats[id];
}

// ============================================================
// ГОЛОВНИЙ ІГРОВИЙ ЦИКЛ
// ============================================================
function startGameLoop(roomId) {
    const game = rooms[roomId];
    if (game.loopInterval) return;

    game.loopInterval = setInterval(() => {
        try {
            if (!rooms[roomId]) return;

            const remainingSeconds = Math.max(0, Math.ceil((game.endTime - Date.now()) / 1000));
            if (remainingSeconds === 0) {
                clearInterval(game.loopInterval);
                updateElo(roomId, game.state.score);
                io.to(roomId).emit('gameOver', game.state.score);
                delete rooms[roomId];
                return;
            }

            const state      = game.state;
            const puck       = state.puck;
            let   hit        = false;

            // Санітарна перевірка шайби
            if (isNaN(puck.x) || isNaN(puck.y) || Math.abs(puck.x) > 4000) {
                puck.x = WIDTH / 2; puck.y = HEIGHT / 2;
                puck.vx = 0; puck.vy = 0;
            }

            // Обмеження швидкості шайби
            const puckSpeed = Math.sqrt(puck.vx ** 2 + puck.vy ** 2);
            if (puckSpeed > MAX_PUCK_SPEED) {
                puck.vx = (puck.vx / puckSpeed) * MAX_PUCK_SPEED;
                puck.vy = (puck.vy / puckSpeed) * MAX_PUCK_SPEED;
            }

            // Рух шайби
            puck.x        += puck.vx;
            puck.y        += puck.vy;
            puck.rotation  = (puck.rotation || 0) + (puck.vr || 0);
            puck.vx       *= FRICTION;
            puck.vy       *= FRICTION;
            puck.vr       *= 0.98;

            // Відбиття від стін (верх/низ)
            if (puck.y - PUCK_RADIUS < WALL_PADDING) {
                puck.y = PUCK_RADIUS + WALL_PADDING; puck.vy *= -0.9; puck.vr += puck.vx * 0.05; hit = true;
            } else if (puck.y + PUCK_RADIUS > HEIGHT - WALL_PADDING) {
                puck.y = HEIGHT - PUCK_RADIUS - WALL_PADDING; puck.vy *= -0.9; puck.vr -= puck.vx * 0.05; hit = true;
            }

            // Ворота та відбиття від бокових стін
            const inGoalZone = puck.y > HEIGHT / 2 - GOAL_HEIGHT / 2 && puck.y < HEIGHT / 2 + GOAL_HEIGHT / 2;
            if (inGoalZone) {
                if (puck.x - PUCK_RADIUS < WALL_PADDING && !state.goalTriggered) {
                    state.score.team2++; state.goalTriggered = true;
                    giveInstantElo(roomId, 2, puck.lastHit);
                    resetAfterGoal(roomId, 'karamelka');
                } else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING && !state.goalTriggered) {
                    state.score.team1++; state.goalTriggered = true;
                    giveInstantElo(roomId, 1, puck.lastHit);
                    resetAfterGoal(roomId, 'korzhik');
                }
            } else {
                if (puck.x - PUCK_RADIUS < WALL_PADDING) {
                    puck.x = PUCK_RADIUS + WALL_PADDING; puck.vx *= -0.9; puck.vr += puck.vy * 0.05; hit = true;
                } else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING) {
                    puck.x = WIDTH - PUCK_RADIUS - WALL_PADDING; puck.vx *= -0.9; puck.vr -= puck.vy * 0.05; hit = true;
                }
            }

            if (state.goalTriggered) { puck.vx *= 0.5; puck.vy *= 0.5; }

            // Відстежуємо поведінку живих гравців (для адаптації ШІ)
            const playerKeys = Object.keys(state.players);
            for (const id of playerKeys) {
                if (!state.players[id].isBot) trackPlayerBehavior(roomId, id);
            }

            const now = Date.now();

            // Цикл по гравцях
            for (let i = 0; i < playerKeys.length; i++) {
                const id = playerKeys[i];
                const p  = state.players[id];

                // AFK → бот
                if (!p.isBot && now - p.lastMoveTime > 15000) {
                    p.isBot = true;
                    io.to(id).emit('afkWarning');
                }

                p.vx = p.vx || 0; p.vy = p.vy || 0; p.vr = p.vr || 0;

                // ── БОТ ──────────────────────────────────────────────────
                if (p.isBot && !state.goalTriggered) {
                    const isTeam1  = p.team === 1;
                    const myGoalX  = isTeam1 ? WALL_PADDING + 60 : WIDTH - WALL_PADDING - 60;
                    const goalY    = HEIGHT / 2;

                    // Параметри по складності
                    // easy:   повільний, великий промах, рідко оновлює ціль
                    // medium: середній
                    // hard:   швидкий, малий промах, часто оновлює
                    const diff = p.botDifficulty || 'medium';
                    const cfg = {
                        easy:   { tickAttack: 28, tickDefend: 10, miss: 70, moveFactor: 0.10, maxSpd: 14 },
                        medium: { tickAttack: 18, tickDefend: 6,  miss: 35, moveFactor: 0.18, maxSpd: 22 },
                        hard:   { tickAttack: 8,  tickDefend: 3,  miss: 8,  moveFactor: 0.28, maxSpd: 32 },
                    }[diff];

                    if (!p._botTick) p._botTick = 0;
                    p._botTick--;

                    if (p._botTick <= 0) {
                        const puckOnOurSide    = isTeam1 ? puck.x < WIDTH * 0.5 : puck.x > WIDTH * 0.5;
                        const puckComingToGoal = isTeam1 ? puck.vx < -2 : puck.vx > 2;
                        const distPuckToMyGoal = Math.abs(puck.x - myGoalX);

                        if (puckComingToGoal && distPuckToMyGoal < 320) {
                            // ЗАХИСТ
                            p._tx = myGoalX + (isTeam1 ? 70 : -70);
                            p._ty = Math.max(
                                goalY - GOAL_HEIGHT / 2 + PLAYER_RADIUS,
                                Math.min(goalY + GOAL_HEIGHT / 2 - PLAYER_RADIUS,
                                    puck.y + (Math.random() - 0.5) * cfg.miss * 0.5)
                            );
                            p._botTick = cfg.tickDefend;
                        } else if (puckOnOurSide) {
                            // АТАКА: підходимо збоку від шайби
                            const miss = (Math.random() - 0.5) * cfg.miss;
                            p._tx = puck.x + (isTeam1 ? -55 : 55);
                            p._ty = puck.y + miss;
                            p._botTick = cfg.tickAttack;
                        } else {
                            // ПОЗИЦІЯ
                            const drift = (Math.random() - 0.5) * cfg.miss * 0.6;
                            p._tx = myGoalX + (isTeam1 ? 180 : -180);
                            p._ty = goalY + (puck.y - goalY) * 0.4 + drift;
                            p._botTick = cfg.tickAttack;
                        }
                    }

                    p.tx           = p._tx;
                    p.ty           = p._ty;
                    p.isDragging   = true;
                    p._botMoveCfg  = { factor: cfg.moveFactor, maxSpd: cfg.maxSpd };
                }
                // ─────────────────────────────────────────────────────────

                if (p.isDragging && p.tx !== undefined && p.ty !== undefined) {
                    const cfg    = p.isBot ? (p._botMoveCfg || { factor: 0.18, maxSpd: 22 }) : { factor: 0.4, maxSpd: 60 };
                    p.vx = (p.tx - p.x) * cfg.factor;
                    p.vy = (p.ty - p.y) * cfg.factor;
                    p.vr *= 0.95;
                    const speed = Math.sqrt(p.vx ** 2 + p.vy ** 2);
                    if (speed > cfg.maxSpd) { p.vx = (p.vx / speed) * cfg.maxSpd; p.vy = (p.vy / speed) * cfg.maxSpd; }
                } else {
                    p.vx *= 0.94; p.vy *= 0.94; p.vr *= 0.97;
                    const speed = Math.sqrt(p.vx ** 2 + p.vy ** 2);
                    if (speed > 3) p.vr += (p.vx > 0 ? 1 : -1) * speed * 0.025;
                }

                p.x        += p.vx;
                p.y        += p.vy;
                p.rotation  = (p.rotation || 0) + p.vr;

                // Межі поля для гравців
                const minX = p.team === 1 ? WALL_PADDING + PLAYER_RADIUS : WIDTH / 2 + PLAYER_RADIUS;
                const maxX = p.team === 1 ? WIDTH / 2 - PLAYER_RADIUS    : WIDTH - WALL_PADDING - PLAYER_RADIUS;
                if (p.x < minX) { p.x = minX; p.vx *= -0.5; }
                if (p.x > maxX) { p.x = maxX; p.vx *= -0.5; }
                if (p.y < WALL_PADDING + PLAYER_RADIUS)         { p.y = WALL_PADDING + PLAYER_RADIUS;         p.vy *= -0.5; }
                if (p.y > HEIGHT - WALL_PADDING - PLAYER_RADIUS){ p.y = HEIGHT - WALL_PADDING - PLAYER_RADIUS; p.vy *= -0.5; }

                // Зіткнення гравця з шайбою
                if (applyPhysics(p, puck, PLAYER_RADIUS, PUCK_RADIUS, 4, 1, 1.6)) {
                    hit = true; puck.lastHit = id;
                }

                // Зіткнення між гравцями
                for (let j = i + 1; j < playerKeys.length; j++) {
                    applyPhysics(p, state.players[playerKeys[j]], PLAYER_RADIUS, PLAYER_RADIUS, 4, 4, 0.8);
                }
            }

            // Надсилаємо стиснутий стан
            const miniState = {
                p: {},
                u: { x: Math.round(puck.x), y: Math.round(puck.y), r: puck.rotation },
                s: state.score,
                t: remainingSeconds,
                h: hit ? 1 : 0,
            };
            for (const id in state.players) {
                const pl = state.players[id];
                if (pl && !isNaN(pl.x)) {
                    miniState.p[id] = {
                        x:     Math.round(pl.x),
                        y:     Math.round(pl.y),
                        r:     pl.rotation || 0,
                        ping:  pl.ping || 0,
                        isBot: pl.isBot,
                    };
                }
            }
            io.to(roomId).emit('gs', miniState);

        } catch (err) {
            console.error('КРАШ УНИКНЕНО:', err);
        }
    }, 1000 / 30);
}

// ============================================================
// PING
// ============================================================
setInterval(() => io.emit('pingTimer', Date.now()), 2000);

// ============================================================
// SOCKET.IO ПІДКЛЮЧЕННЯ
// ============================================================
io.on('connection', (socket) => {
    let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (typeof ip === 'string') ip = ip.split(',')[0].trim();

    if (!ipConnections[ip]) ipConnections[ip] = 0;
    ipConnections[ip]++;
    if (ipConnections[ip] > 15) { socket.disconnect(true); return; }

    totalOnline++;
    io.emit('onlineCount', totalOnline);

    // ── РЕЄСТРАЦІЯ ────────────────────────────────────────────────────
    socket.on('register', ({ username, password }) => {
        if (usersDb[username]) {
            return socket.emit('authResult', { success: false, msg: 'Ім\'я вже зайнято!' });
        }
        usersDb[username] = { password, elo: 1000 };
        socket.emit('authResult', { success: true, username, elo: 1000 });
    });

    // ── ВХІД ─────────────────────────────────────────────────────────
    socket.on('login', ({ username, password }) => {
        const user = usersDb[username];
        if (user && user.password === password) {
            socket.emit('authResult', { success: true, username, elo: user.elo });
        } else {
            socket.emit('authResult', { success: false, msg: 'Невірний логін або пароль!' });
        }
    });

    // ── ПОШУК МАТЧУ ──────────────────────────────────────────────────
    socket.on('findMatch', (data) => {
        try {
            const mode  = data.mode;
            const queue = queues[mode];

            if (!queue.find(p => p.socket.id === socket.id)) queue.push({ socket, data });

            if (queue.length >= mode * 2) {
                const playersInMatch = queue.splice(0, mode * 2);
                const roomId         = `room_${Date.now()}`;
                const gameState      = initGameState();

                playersInMatch.forEach((p, index) => {
                    p.socket.join(roomId);
                    const team = index < mode ? 1 : 2;
                    gameState.players[p.socket.id] = {
                        x:            team === 1 ? 150 : 1050,
                        y:            300 + index * 20,
                        char:         p.data.character,
                        team,
                        username:     p.data.username,
                        ping:         0,
                        lastMoveTime: Date.now(),
                        isBot:        false,
                        isDragging:   false,
                    };
                });

                rooms[roomId] = {
                    state:       gameState,
                    players:     playersInMatch.map(p => p.socket.id),
                    endTime:     Date.now() + 180 * 1000,
                    eloAwarded:  false,
                };

                io.to(roomId).emit('matchFound', { roomId, state: gameState });
                startGameLoop(roomId);
            } else {
                socket.emit('waiting', `Очікування гравців (${queue.length}/${mode * 2})...`);
            }
        } catch (err) {
            console.error('findMatch error:', err);
        }
    });

    // ── СКАСУВАННЯ ЧЕРГИ ─────────────────────────────────────────────
    socket.on('cancelMatchMatchmaking', () => {
        [1, 2, 3].forEach(mode => {
            queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id);
        });
    });

    // ── ГЛЯДАЧ ───────────────────────────────────────────────────────
    socket.on('spectateRandom', () => {
        const activeRoomsIds = Object.keys(rooms);
        if (activeRoomsIds.length === 0) {
            socket.emit('spectateError', 'Зараз немає активних ігор 😔'); return;
        }
        const randomRoomId = activeRoomsIds[Math.floor(Math.random() * activeRoomsIds.length)];
        socket.join(randomRoomId);
        socket.emit('spectateStart', { roomId: randomRoomId, state: rooms[randomRoomId].state });
    });

    // ── ВВЕДЕННЯ ГРИ ─────────────────────────────────────────────────
    socket.on('input', (data) => {
        try {
            if (!data || !data.roomId || !rooms[data.roomId]) return;
            const player = rooms[data.roomId].state.players[socket.id];
            if (player && !player.isBot) {
                player.lastMoveTime = Date.now();
                player.isDragging   = data.dragging;
                if (data.dragging) {
                    player.tx = Number(data.tx);
                    player.ty = Number(data.ty);
                }
            }
        } catch (err) {}
    });

    // ── PING ─────────────────────────────────────────────────────────
    socket.on('pongTimer', (timestamp) => {
        for (const roomId in rooms) {
            const p = rooms[roomId].state.players[socket.id];
            if (p) { p.ping = Date.now() - timestamp; break; }
        }
    });

    // ── ЧАТ ──────────────────────────────────────────────────────────
    socket.on('chatMessage', (data) => {
        if (rooms[data.roomId]) {
            io.to(data.roomId).emit('chatMessage', { sender: data.sender, text: data.text });
        }
    });

    // ── ВІДКЛЮЧЕННЯ ──────────────────────────────────────────────────
    socket.on('disconnect', () => {
        ipConnections[ip]--;
        totalOnline--;
        io.emit('onlineCount', totalOnline);
        [1, 2, 3].forEach(mode => {
            queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id);
        });
        for (const roomId in rooms) {
            if (rooms[roomId].players.includes(socket.id)) {
                const p = rooms[roomId].state.players[socket.id];
                if (p) p.isBot = true;
            }
        }
    });
});

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущено: http://localhost:${PORT}`));
