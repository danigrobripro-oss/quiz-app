const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// Stockage des parties
const games = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function sendQuestion(gameCode) {
  const game = games.get(gameCode);
  if (!game || game.state !== 'playing') return;
  
  if (game.currentQuestion >= game.quiz.questions.length) {
    endGame(gameCode);
    return;
  }
  
  const q = game.quiz.questions[game.currentQuestion];
  let timeLeft = 15;
  
  io.to(gameCode).emit('new_question', {
    question: q.text,
    options: q.options,
    timeLimit: 15,
    qIndex: game.currentQuestion + 1,
    total: game.quiz.questions.length
  });
  
  if (game.questionInterval) clearInterval(game.questionInterval);
  game.questionInterval = setInterval(() => {
    timeLeft--;
    io.to(gameCode).emit('timer_update', { timeLeft });
    if (timeLeft <= 0) {
      clearInterval(game.questionInterval);
      nextQuestion(gameCode);
    }
  }, 1000);
}

function nextQuestion(gameCode) {
  const game = games.get(gameCode);
  if (!game) return;
  game.currentQuestion++;
  game.players.forEach(p => p.answered = false);
  sendQuestion(gameCode);
}

function endGame(gameCode) {
  const game = games.get(gameCode);
  if (!game) return;
  if (game.questionInterval) clearInterval(game.questionInterval);
  game.state = 'ended';
  const scores = game.players.map(p => ({ name: p.name, score: p.score })).sort((a,b) => b.score - a.score);
  io.to(gameCode).emit('game_ended', { scores });
  setTimeout(() => games.delete(gameCode), 300000);
}

io.on('connection', (socket) => {
  console.log('✅ Connecté:', socket.id);

  socket.on('create_game', ({ quiz, hostName }) => {
    const code = generateCode();
    games.set(code, {
      code, quiz, host: socket.id, hostName,
      players: [], state: 'waiting', currentQuestion: 0, scores: {}
    });
    socket.join(code);
    socket.emit('game_created', { gameCode: code });
  });

  socket.on('join_game', ({ gameCode, playerName }) => {
    const game = games.get(gameCode);
    if (!game) return socket.emit('error', 'Code invalide');
    if (game.state !== 'waiting') return socket.emit('error', 'Partie déjà commencée');
    if (game.players.some(p => p.name === playerName)) return socket.emit('error', 'Pseudo déjà pris');
    
    game.players.push({ id: socket.id, name: playerName, score: 0, answered: false });
    socket.join(gameCode);
    socket.emit('joined', { gameCode, quizTitle: game.quiz.title });
    io.to(gameCode).emit('players_update', game.players.map(p => ({ name: p.name, score: p.score })));
  });

  socket.on('start_game', ({ gameCode }) => {
    const game = games.get(gameCode);
    if (!game || game.host !== socket.id) return;
    if (game.players.length === 0) return socket.emit('error', 'Aucun joueur');
    game.state = 'playing';
    game.currentQuestion = 0;
    game.players.forEach(p => p.answered = false);
    io.to(gameCode).emit('game_started', { total: game.quiz.questions.length });
    sendQuestion(gameCode);
  });

  socket.on('next_question', ({ gameCode }) => {
    const game = games.get(gameCode);
    if (!game || game.host !== socket.id) return;
    if (game.questionInterval) clearInterval(game.questionInterval);
    nextQuestion(gameCode);
  });

  socket.on('submit_answer', ({ gameCode, answerIndex }) => {
    const game = games.get(gameCode);
    if (!game || game.state !== 'playing') return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player || player.answered) return;
    
    const q = game.quiz.questions[game.currentQuestion];
    const isCorrect = (answerIndex === q.correct);
    const points = isCorrect ? 1000 : 0;
    player.score += points;
    player.answered = true;
    
    socket.emit('answer_result', { correct: isCorrect, points, correctAnswer: q.options[q.correct] });
    io.to(gameCode).emit('players_update', game.players.map(p => ({ name: p.name, score: p.score })));
  });

  socket.on('disconnect', () => {
    for (const [code, game] of games.entries()) {
      if (game.host === socket.id) {
        io.to(code).emit('host_disconnected');
        games.delete(code);
      }
    }
  });
});

// ========== FRONTEND (tout en un) ==========
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Quiz App - Multijoueur</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        body { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        
        /* Glassmorphism moderne */
        .glass { background: rgba(255, 255, 255, 0.1); backdrop-filter: blur(12px); border-radius: 28px; border: 1px solid rgba(255,255,255,0.15); padding: 28px; margin-bottom: 24px; }
        .glass-card { background: rgba(255, 255, 255, 0.08); backdrop-filter: blur(8px); border-radius: 20px; padding: 20px; border: 1px solid rgba(255,255,255,0.1); transition: all 0.3s; cursor: pointer; }
        .glass-card:hover { transform: translateY(-3px); background: rgba(255,255,255,0.15); }
        
        .mode-bar { display: flex; gap: 15px; justify-content: center; margin-bottom: 30px; flex-wrap: wrap; }
        .mode-btn { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.2); padding: 12px 28px; border-radius: 40px; font-weight: 600; cursor: pointer; color: white; transition: 0.3s; }
        .mode-btn.active { background: white; color: #1a1a2e; border-color: white; box-shadow: 0 5px 20px rgba(0,0,0,0.2); }
        
        button { background: linear-gradient(135deg, #667eea, #764ba2); border: none; padding: 12px 24px; border-radius: 40px; font-weight: 600; color: white; cursor: pointer; font-size: 0.9rem; transition: 0.2s; }
        button:hover { transform: scale(1.02); box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
        button.secondary { background: rgba(255,255,255,0.2); }
        button.success { background: linear-gradient(135deg, #00b4db, #0083b0); }
        
        input, select { background: rgba(255,255,255,0.9); border: none; border-radius: 16px; padding: 14px 18px; width: 100%; margin-bottom: 15px; font-size: 1rem; outline: none; }
        input:focus { box-shadow: 0 0 0 2px #667eea; }
        
        .quiz-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; margin-top: 20px; }
        
        .options-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 20px; }
        .option-btn { background: rgba(255,255,255,0.15); padding: 16px; border-radius: 50px; font-weight: 600; text-align: center; cursor: pointer; transition: 0.2s; border: 1px solid rgba(255,255,255,0.2); color: white; }
        .option-btn:hover { background: rgba(255,255,255,0.3); transform: scale(1.02); }
        
        .timer-bar { height: 8px; background: rgba(255,255,255,0.2); border-radius: 10px; margin: 15px 0; overflow: hidden; }
        .timer-fill { height: 100%; background: #00b4db; width: 100%; border-radius: 10px; transition: width 0.1s linear; }
        
        .code-display { font-size: 2.5rem; letter-spacing: 12px; background: rgba(0,0,0,0.3); border-radius: 20px; padding: 20px; font-family: monospace; font-weight: bold; text-align: center; color: white; }
        
        .player-list { background: rgba(255,255,255,0.08); border-radius: 20px; padding: 15px; margin-top: 15px; }
        .player-item { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; color: white; }
        
        h1, h2, h3, h4, p { color: white; }
        h2 { margin-bottom: 15px; font-size: 1.5rem; }
        
        .chat-window { background: rgba(0,0,0,0.3); border-radius: 24px; height: 400px; display: flex; flex-direction: column; overflow: hidden; }
        .chat-messages { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
        .bot-msg, .user-msg { max-width: 80%; padding: 12px 18px; border-radius: 20px; font-size: 0.9rem; }
        .bot-msg { background: #667eea; color: white; align-self: flex-start; }
        .user-msg { background: rgba(255,255,255,0.2); color: white; align-self: flex-end; }
        
        .question-block { background: rgba(255,255,255,0.1); border-radius: 20px; padding: 15px; margin-bottom: 15px; }
        
        .correct-feedback { background: #00c853; color: white; padding: 12px; border-radius: 20px; margin-top: 15px; text-align: center; animation: bounce 0.5s; }
        .wrong-feedback { background: #ff5252; color: white; padding: 12px; border-radius: 20px; margin-top: 15px; text-align: center; }
        @keyframes bounce { 0%,100%{transform:scale(1)} 50%{transform:scale(1.02)} }
        
        @media (max-width: 700px) { .options-grid { grid-template-columns: 1fr; } .code-display { font-size: 1.5rem; letter-spacing: 5px; } }
    </style>
</head>
<body>
<div class="container">
    <div class="mode-bar">
        <button class="mode-btn active" id="btnHostMode">🎮 Créer / Organiser</button>
        <button class="mode-btn" id="btnPlayerMode">📱 Rejoindre</button>
    </div>

    <div id="hostPanel">
        <div class="glass">
            <h2>✨ Créer un quiz</h2>
            <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px;">
                <button id="quickCreateBtn">⚡ Création rapide (IA)</button>
                <button id="chatbotCreateBtn" class="secondary">🤖 Chatbot</button>
                <button id="manualCreateBtn" class="secondary">📝 Manuel (1-40 questions)</button>
            </div>
            <h3>📚 Mes quiz</h3>
            <div id="quizList" class="quiz-grid"></div>
        </div>
        <div id="hostGamePanel" class="glass" style="display: none;">
            <div id="hostRoomInfo"></div>
            <div id="playersList" class="player-list"></div>
            <div id="gameControls"></div>
        </div>
    </div>

    <div id="playerPanel" style="display: none;">
        <div class="glass" id="playerJoinArea">
            <h2>🔑 Rejoindre</h2>
            <input type="text" id="joinCode" placeholder="Code 6 chiffres" maxlength="6">
            <input type="text" id="playerName" placeholder="Pseudo">
            <button id="joinRoomBtn">🎯 Rejoindre</button>
        </div>
        <div id="playerGameArea" class="glass" style="display: none;">
            <div id="gameStatus"></div>
            <div id="questionArea"></div>
            <div id="playerLeaderboard" class="player-list"></div>
        </div>
    </div>
</div>

<script>
    let quizzes = JSON.parse(localStorage.getItem('quizapp_quizzes') || '[]');
    function saveQuizzes() { localStorage.setItem('quizapp_quizzes', JSON.stringify(quizzes)); }
    
    function renderQuizList() {
        const container = document.getElementById('quizList');
        if (!container) return;
        if (quizzes.length === 0) { container.innerHTML = '<p style="color:rgba(255,255,255,0.7);">Aucun quiz. Créez-en un !</p>'; return; }
        container.innerHTML = quizzes.map((quiz, idx) => \`
            <div class="glass-card">
                <strong style="font-size:1.2rem;">\${escapeHtml(quiz.title)}</strong>
                <p style="margin:10px 0; opacity:0.7;">📋 \${quiz.questions.length} questions</p>
                <button class="host-quiz-btn" data-idx="\${idx}">🚀 Héberger</button>
            </div>
        \`).join('');
        document.querySelectorAll('.host-quiz-btn').forEach(btn => {
            btn.addEventListener('click', () => startHostingQuiz(parseInt(btn.dataset.idx)));
        });
    }
    
    // Création rapide
    function quickCreate() {
        let theme = prompt("Thème (ex: Marketing, Économie, Histoire)", "Quiz STMG");
        if (!theme) return;
        let nb = parseInt(prompt("Nombre de questions (1-40)", "5"));
        if (isNaN(nb)) nb = 5;
        nb = Math.min(40, Math.max(1, nb));
        let questions = [];
        for (let i = 0; i < nb; i++) {
            questions.push({
                text: \`Question \${i+1} sur \${theme}\`,
                options: ["Option A", "Option B", "Option C", "Option D"],
                correct: Math.floor(Math.random() * 4)
            });
        }
        quizzes.push({ title: \`Quiz \${theme}\`, questions, id: Date.now() });
        saveQuizzes();
        renderQuizList();
        alert(\`✅ Quiz "\${theme}" créé !\`);
    }
    
    // Chatbot
    function openChatbot() {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:1000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = \`
            <div class="glass" style="width:90%;max-width:550px;">
                <h2>🤖 Chatbot</h2>
                <div class="chat-window">
                    <div class="chat-messages" id="chatbotMsgs">
                        <div class="bot-msg">Salut ! Donne-moi un thème + nombre de questions.</div>
                        <div class="bot-msg">Ex: "Droit STMG 8" ou "Marketing 5"</div>
                    </div>
                    <div style="display:flex; gap:8px; padding:12px;">
                        <input type="text" id="chatbotInput" placeholder="Écris ici..." style="margin:0;">
                        <button id="sendChatbotMsg">Envoyer</button>
                    </div>
                </div>
                <button id="closeChatbotBtn" class="secondary" style="margin-top:16px;">Fermer</button>
            </div>
        \`;
        document.body.appendChild(modal);
        
        const msgDiv = document.getElementById('chatbotMsgs');
        const input = document.getElementById('chatbotInput');
        
        function addBotMsg(txt) { const d = document.createElement('div'); d.className = 'bot-msg'; d.innerText = txt; msgDiv.appendChild(d); msgDiv.scrollTop = msgDiv.scrollHeight; }
        function addUserMsg(txt) { const d = document.createElement('div'); d.className = 'user-msg'; d.innerText = txt; msgDiv.appendChild(d); msgDiv.scrollTop = msgDiv.scrollHeight; }
        
        function generateQuiz(promptText) {
            let nbMatch = promptText.match(/\\d+/);
            let nb = nbMatch ? Math.min(40, Math.max(1, parseInt(nbMatch[0]))) : 5;
            let theme = promptText.replace(/\\d+/g, '').trim() || "Quiz";
            let questions = [];
            for (let i = 0; i < nb; i++) {
                questions.push({
                    text: \`Question \${i+1} sur \${theme}\`,
                    options: [\`Option A (\${theme})\`, \`Option B (\${theme})\`, \`Option C (\${theme})\`, \`Option D (\${theme})\`],
                    correct: Math.floor(Math.random() * 4)
                });
            }
            quizzes.push({ title: \`Quiz \${theme}\`, questions, id: Date.now() });
            saveQuizzes();
            renderQuizList();
            return \`"\${theme}" avec \${nb} questions\`;
        }
        
        function processAnswer(answer) {
            addUserMsg(answer);
            let result = generateQuiz(answer);
            addBotMsg(\`🎉 Quiz \${result} créé !\`);
            setTimeout(() => modal.remove(), 2000);
        }
        
        document.getElementById('sendChatbotMsg').onclick = () => { let v = input.value.trim(); if(v) processAnswer(v); };
        input.addEventListener('keypress', (e) => { if(e.key === 'Enter') document.getElementById('sendChatbotMsg').click(); });
        document.getElementById('closeChatbotBtn').onclick = () => modal.remove();
    }
    
    // Manuel
    function openManualCreator() {
        let nb = parseInt(prompt("Nombre de questions (1-40)", "5"));
        if (isNaN(nb)) nb = 5;
        nb = Math.min(40, Math.max(1, nb));
        let title = prompt("Titre du quiz", "Mon quiz");
        if (!title) return;
        let questions = [];
        for (let i = 0; i < nb; i++) {
            let qText = prompt(\`Question \${i+1}/\${nb}:\`, \`Question \${i+1}\`);
            if (!qText) continue;
            let opts = [];
            for (let j = 0; j < 4; j++) {
                let opt = prompt(\`Option \${String.fromCharCode(65+j)}:\`, \`Option \${String.fromCharCode(65+j)}\`);
                opts.push(opt || \`Option \${String.fromCharCode(65+j)}\`);
            }
            let correct = parseInt(prompt("Bonne réponse (1-4):", "1")) - 1;
            if (isNaN(correct)) correct = 0;
            questions.push({ text: qText, options: opts, correct });
        }
        if (questions.length > 0) {
            quizzes.push({ title, questions, id: Date.now() });
            saveQuizzes();
            renderQuizList();
            alert(\`✅ Quiz "\${title}" créé !\`);
        }
    }
    
    // Socket
    const socket = io();
    let currentRoom = null;
    
    function startHostingQuiz(quizIndex) {
        const quiz = quizzes[quizIndex];
        if (!quiz) return;
        let hostName = prompt("Votre pseudo:", "Professeur");
        if (!hostName) return;
        socket.emit('create_game', { quiz, hostName });
        socket.once('game_created', (data) => {
            currentRoom = data.gameCode;
            document.getElementById('hostGamePanel').style.display = 'block';
            document.getElementById('hostRoomInfo').innerHTML = \`
                <div style="text-align:center;">
                    <p>🔑 Code :</p>
                    <div class="code-display">\${data.gameCode}</div>
                    <button id="startGameBtn" class="success" style="margin-top:15px;">🚀 Démarrer</button>
                </div>
            \`;
            document.getElementById('startGameBtn').onclick = () => socket.emit('start_game', { gameCode: currentRoom });
        });
        
        socket.on('players_update', (players) => {
            document.getElementById('playersList').innerHTML = \`<h4>👥 Joueurs (\${players.length})</h4>\` + players.map(p => \`<div class="player-item"><span>\${escapeHtml(p.name)}</span><span>⭐ \${p.score}</span></div>\`).join('');
        });
        
        socket.on('game_started', (data) => { document.getElementById('hostRoomInfo').innerHTML = \`<h3>🎮 Partie - \${data.total} questions</h3>\`; });
        
        socket.on('new_question', (data) => {
            document.getElementById('gameControls').innerHTML = \`
                <div style="text-align:center;">
                    <h3>📢 \${data.qIndex}/\${data.total}</h3>
                    <h2>\${escapeHtml(data.question)}</h2>
                    <div class="timer-bar"><div class="timer-fill" style="width:100%"></div></div>
                    <div class="options-grid">
                        \${data.options.map((opt,i) => \`<div class="option-btn">\${String.fromCharCode(65+i)}. \${escapeHtml(opt)}</div>\`).join('')}
                    </div>
                    <button id="nextQBtn" style="margin-top:20px;">⏩ Suivant</button>
                </div>
            \`;
            document.getElementById('nextQBtn').onclick = () => socket.emit('next_question', { gameCode: currentRoom });
            let timeLeft = data.timeLimit;
            let fill = document.querySelector('.timer-fill');
            let interval = setInterval(() => { timeLeft--; if(fill && timeLeft>=0) fill.style.width = \`\${(timeLeft/data.timeLimit)*100}%\`; if(timeLeft<=0) clearInterval(interval); }, 1000);
        });
        
        socket.on('game_ended', (data) => {
            document.getElementById('gameControls').innerHTML = \`
                <h2>🏆 Terminé !</h2>
                \${data.scores.map(s => \`<div class="player-item"><span>\${escapeHtml(s.name)}</span><span>\${s.score} pts</span></div>\`).join('')}
                <button onclick="location.reload()" style="margin-top:20px;">➕ Nouveau</button>
            \`;
        });
        
        socket.on('error', (msg) => alert(msg));
    }
    
    function joinGame() {
        let code = document.getElementById('joinCode').value.trim().toUpperCase();
        let name = document.getElementById('playerName').value.trim();
        if (!code || !name) { alert("Code et pseudo requis"); return; }
        socket.emit('join_game', { gameCode: code, playerName: name });
        
        socket.once('joined', (data) => {
            currentRoom = data.gameCode;
            document.getElementById('playerJoinArea').style.display = 'none';
            document.getElementById('playerGameArea').style.display = 'block';
            document.getElementById('gameStatus').innerHTML = \`<div style="background:#00c853;padding:12px;border-radius:20px;">✅ Connecté - En attente...</div>\`;
        });
        
        socket.on('game_started', (data) => { document.getElementById('gameStatus').innerHTML = \`<div style="background:#667eea;padding:12px;border-radius:20px;">🎯 Commencé ! \${data.total} questions</div>\`; });
        
        socket.on('new_question', (data) => {
            document.getElementById('questionArea').innerHTML = \`
                <div>
                    <h3>Question \${data.qIndex}/\${data.total}</h3>
                    <h2>\${escapeHtml(data.question)}</h2>
                    <div class="timer-bar"><div class="timer-fill" style="width:100%"></div></div>
                    <div class="options-grid" id="playerOptionsGrid"></div>
                </div>
            \`;
            let grid = document.getElementById('playerOptionsGrid');
            data.options.forEach((opt, idx) => {
                let btn = document.createElement('button');
                btn.className = 'option-btn';
                btn.innerText = \`\${String.fromCharCode(65+idx)}. \${escapeHtml(opt)}\`;
                btn.onclick = () => { socket.emit('submit_answer', { gameCode: currentRoom, answerIndex: idx }); grid.querySelectorAll('button').forEach(b => b.disabled = true); };
                grid.appendChild(btn);
            });
            let timeLeft = data.timeLimit;
            let fill = document.querySelector('.timer-fill');
            let interval = setInterval(() => { timeLeft--; if(fill && timeLeft>=0) fill.style.width = \`\${(timeLeft/data.timeLimit)*100}%\`; if(timeLeft<=0) { clearInterval(interval); grid.querySelectorAll('button').forEach(b => b.disabled = true); } }, 1000);
        });
        
        socket.on('answer_result', (data) => {
            let fb = document.createElement('div');
            fb.className = data.correct ? 'correct-feedback' : 'wrong-feedback';
            fb.innerHTML = data.correct ? \`✅ + \${data.points} points\` : \`❌ Réponse : \${data.correctAnswer}\`;
            document.getElementById('questionArea').appendChild(fb);
            setTimeout(() => fb.remove(), 2000);
        });
        
        socket.on('players_update', (players) => {
            document.getElementById('playerLeaderboard').innerHTML = \`<h4>🏆 Classement</h4>\` + players.map((p,i) => \`<div class="player-item"><span>\${i+1}. \${escapeHtml(p.name)}</span><span>\${p.score} pts</span></div>\`).join('');
        });
        
        socket.on('game_ended', (data) => {
            document.getElementById('questionArea').innerHTML = \`
                <h2>🎉 Terminé !</h2>
                \${data.scores.map(s => \`<div class="player-item"><span>\${escapeHtml(s.name)}</span><span>\${s.score} pts</span></div>\`).join('')}
                <button onclick="location.reload()" style="margin-top:20px;">🎮 Rejouer</button>
            \`;
        });
        
        socket.on('error', (msg) => alert(msg));
    }
    
    function escapeHtml(str) { if(!str) return ''; return str.replace(/[&<>]/g, function(m){ if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }
    
    document.getElementById('btnHostMode').onclick = () => { document.getElementById('hostPanel').style.display = 'block'; document.getElementById('playerPanel').style.display = 'none'; document.getElementById('btnHostMode').classList.add('active'); document.getElementById('btnPlayerMode').classList.remove('active'); renderQuizList(); };
    document.getElementById('btnPlayerMode').onclick = () => { document.getElementById('hostPanel').style.display = 'none'; document.getElementById('playerPanel').style.display = 'block'; document.getElementById('btnPlayerMode').classList.add('active'); document.getElementById('btnHostMode').classList.remove('active'); document.getElementById('playerJoinArea').style.display = 'block'; document.getElementById('playerGameArea').style.display = 'none'; };
    document.getElementById('quickCreateBtn').onclick = quickCreate;
    document.getElementById('chatbotCreateBtn').onclick = openChatbot;
    document.getElementById('manualCreateBtn').onclick = openManualCreator;
    document.getElementById('joinRoomBtn').onclick = joinGame;
    
    renderQuizList();
</script>
</body>
</html>
  \`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Serveur démarré sur http://localhost:${PORT}`));
