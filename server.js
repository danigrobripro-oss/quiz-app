const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
  clearInterval(game.questionInterval);
  game.state = 'ended';
  const scores = game.players.map(p => ({ name: p.name, score: p.score })).sort((a,b) => b.score - a.score);
  io.to(gameCode).emit('game_ended', { scores });
  setTimeout(() => games.delete(gameCode), 300000);
}

io.on('connection', (socket) => {
  console.log('Connecté:', socket.id);

  socket.on('create_game', ({ quiz, hostName }) => {
    const code = generateCode();
    games.set(code, {
      code, quiz, host: socket.id, hostName,
      players: [], state: 'waiting', currentQuestion: 0,
      scores: {}
    });
    socket.join(code);
    socket.emit('game_created', { gameCode: code });
  });

  socket.on('join_game', ({ gameCode, playerName }) => {
    const game = games.get(gameCode);
    if (!game) return socket.emit('error', 'Code invalide');
    if (game.state !== 'waiting') return socket.emit('error', 'Partie commencée');
    
    game.players.push({ id: socket.id, name: playerName, score: 0, answered: false });
    socket.join(gameCode);
    socket.emit('joined', { gameCode, quizTitle: game.quiz.title });
    io.to(gameCode).emit('players_update', game.players.map(p => ({ name: p.name, score: p.score })));
  });

  socket.on('start_game', ({ gameCode }) => {
    const game = games.get(gameCode);
    if (!game || game.host !== socket.id) return;
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
    player.score += isCorrect ? 1000 : 0;
    player.answered = true;
    
    socket.emit('answer_result', { correct: isCorrect, points: isCorrect ? 1000 : 0, correctAnswer: q.options[q.correct] });
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Serveur sur http://localhost:${PORT}`));