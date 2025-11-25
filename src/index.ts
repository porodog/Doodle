import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

type Player = {
  id: string;
  nickname: string;
  score: number;
};

type RoomState = {
  id: string;
  players: Record<string, Player>;
  drawerId: string | null | undefined;
  currentWord: string | null | undefined;
  round: number;
  maxRounds: number;
  category: string;
  roundActive: boolean;
  timerId?: NodeJS.Timeout | null;
  hintTimerId?: NodeJS.Timeout | null;
};

const WORD_POOL: Record<string, string[]> = {
  food: ["사과", "바나나", "피자", "햄버거"],
  animal: ["고양이", "강아지"],
  object: ["집", "자동차", "별", "구름", "컵", "책"],
};

const ROUND_DURATION_SEC = 40;
const ROUND_DURATION_MS = ROUND_DURATION_SEC * 1000;

const CHO = [
  "ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ",
  "ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ",
];

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

const rooms = new Map<string, RoomState>();
const socketRoomMap = new Map<string, string>();

const getOrCreateRoom = (roomId: string): RoomState => {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      players: {},
      drawerId: null,
      currentWord: null,
      round: 0,
      maxRounds: 5,
      category: "food",
      roundActive: false,
      timerId: null,
      hintTimerId: null,
    };
    rooms.set(roomId, room);
  }
  return room;
};

const getPlayerList = (room: RoomState): Player[] =>
  Object.values(room.players);

const makeChosungHint = (word: string): string =>
  Array.from(word)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code < 0xac00 || code > 0xd7a3) return ch;
      const base = code - 0xac00;
      const choIndex = Math.floor(base / (21 * 28));
      return CHO[choIndex] ?? ch;
    })
    .join("");

const getRandomWord = (category: string): string => {
  const list = WORD_POOL[category] ?? WORD_POOL["food"];
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
};

const clearRoomTimers = (room: RoomState) => {
  if (room.timerId) {
    clearTimeout(room.timerId);
    room.timerId = null;
  }
  if (room.hintTimerId) {
    clearTimeout(room.hintTimerId);
    room.hintTimerId = null;
  }
};

const broadcastRoomState = (roomId: string) => {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("roomState", {
    players: getPlayerList(room),
    drawerId: room.drawerId,
    round: room.round,
    maxRounds: room.maxRounds,
    category: room.category,
    roundActive: room.roundActive,
  });
};

const chooseNextDrawerId = (room: RoomState): string | null => {
  const ids = Object.keys(room.players);
  if (ids.length === 0) return null;
  if (!room.drawerId) return ids[0];
  const idx = ids.indexOf(room.drawerId);
  if (idx === -1 || idx === ids.length - 1) return ids[0];
  return ids[idx + 1];
};

const startRound = (roomId: string) => {
  const room = rooms.get(roomId);
  if (!room) return;
  if (Object.keys(room.players).length === 0) return;

  clearRoomTimers(room);

  room.round += 1;
  if (room.round > room.maxRounds) {
    room.roundActive = false;
    room.currentWord = null;
    room.drawerId = null;

    io.to(roomId).emit("gameEnded", {
      players: getPlayerList(room),
    });
    io.to(roomId).emit("clearCanvas");
    io.to(roomId).emit("hintUpdated", { hint: "" });

    broadcastRoomState(roomId);
    return;
  }

  const nextDrawerId = chooseNextDrawerId(room);
  room.drawerId = nextDrawerId;
  room.currentWord = getRandomWord(room.category);
  room.roundActive = true;

  io.to(roomId).emit("clearCanvas");
  io.to(roomId).emit("hintUpdated", { hint: "" });

  io.to(roomId).emit("roundStarted", {
    round: room.round,
    maxRounds: room.maxRounds,
    drawerId: room.drawerId,
    roundDurationSec: ROUND_DURATION_SEC,
  });

  if (room.drawerId && room.currentWord) {
    io.to(room.drawerId).emit("wordForDrawer", {
      word: room.currentWord,
    });
  }

  broadcastRoomState(roomId);

  room.hintTimerId = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || !r.roundActive || !r.currentWord) return;
    const hint = makeChosungHint(r.currentWord);
    io.to(roomId).emit("hintUpdated", { hint });
  }, ROUND_DURATION_MS / 2);

  room.timerId = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || !r.roundActive) return;
    io.to(roomId).emit("roundEnded", {
      reason: "시간이 종료되었습니다.",
      round: r.round,
    });
    io.to(roomId).emit("clearCanvas");
    io.to(roomId).emit("hintUpdated", { hint: "" });
    r.roundActive = false;
    broadcastRoomState(roomId);
    setTimeout(() => startRound(roomId), 3000);
  }, ROUND_DURATION_MS);
};

io.on("connection", (socket) => {
  console.log("새 접속:", socket.id);

  socket.on(
    "joinRoom",
    ({ roomId, nickname }: { roomId: string; nickname: string }) => {
      const trimmedRoomId = roomId.trim() || Math.random().toString(36).slice(2, 8);
      const trimmedNick = nickname.trim() || "익명";

      const room = getOrCreateRoom(trimmedRoomId);

      const prevRoomId = socketRoomMap.get(socket.id);
      if (prevRoomId && rooms.has(prevRoomId)) {
        socket.leave(prevRoomId);
        const prevRoom = rooms.get(prevRoomId)!;
        delete prevRoom.players[socket.id];
        broadcastRoomState(prevRoomId);
      }

      socket.join(trimmedRoomId);
      socketRoomMap.set(socket.id, trimmedRoomId);

      room.players[socket.id] = {
        id: socket.id,
        nickname: trimmedNick,
        score: 0,
      };

      io.to(trimmedRoomId).emit("systemMessage", {
        message: `${trimmedNick} 님이 입장했습니다.`,
      });

      broadcastRoomState(trimmedRoomId);
    }
  );

  socket.on("setCategory", (cat: string) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.category = cat || "food";
    broadcastRoomState(roomId);
  });

  socket.on("startGame", () => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    const room = getOrCreateRoom(roomId);
    if (room.roundActive) return;

    room.round = 0;
    room.currentWord = null;
    room.drawerId = null;

    io.to(roomId).emit("systemMessage", {
      message: "게임을 시작합니다!",
    });

    startRound(roomId);
  });

  socket.on(
    "draw",
    (data: {
      roomId: string;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      color: string;
      lineWidth: number;
    }) => {
      const { roomId, x0, y0, x1, y1, color, lineWidth } = data;
      socket.to(roomId).emit("draw", {
        x0,
        y0,
        x1,
        y1,
        color,
        lineWidth,
      });
    }
  );

  socket.on("clearCanvas", ({ roomId }: { roomId: string }) => {
    socket.to(roomId).emit("clearCanvas");
  });

  socket.on("answer", ({ message }: { message: string }) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    const text = message.trim();
    if (!text) return;

    if (!room.roundActive || !room.currentWord) {
      io.to(roomId).emit("chat", {
        nickname: player.nickname,
        message: text,
        correct: false,
      });
      return;
    }

    if (room.drawerId === socket.id) {
      io.to(roomId).emit("chat", {
        nickname: player.nickname,
        message: text,
        correct: false,
      });
      return;
    }

    const normalizedInput = text.toLowerCase();
    const normalizedAnswer = room.currentWord.toLowerCase();

    if (normalizedInput === normalizedAnswer) {
      player.score += 10;

      io.to(roomId).emit("answerResult", {
        correct: true,
        playerId: player.id,
        nickname: player.nickname,
        word: room.currentWord,
        newScore: player.score,
      });

      io.to(roomId).emit("roundEnded", {
        reason: `${player.nickname} 님이 정답을 맞췄습니다!`,
        round: room.round,
      });
      io.to(roomId).emit("clearCanvas");
      io.to(roomId).emit("hintUpdated", { hint: "" });

      room.roundActive = false;
      broadcastRoomState(roomId);
      setTimeout(() => startRound(roomId), 3000);
    } else {
      io.to(roomId).emit("chat", {
        nickname: player.nickname,
        message: text,
        correct: false,
      });
      broadcastRoomState(roomId);
    }
  });

  socket.on("chatMessage", ({ message }: { message: string }) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    io.to(roomId).emit("chat", {
      nickname: player.nickname,
      message,
      correct: false,
    });
  });

  socket.on("disconnect", () => {
    console.log("접속 종료:", socket.id);
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const nickname = room.players[socket.id]?.nickname ?? "알 수 없음";

    delete room.players[socket.id];
    socketRoomMap.delete(socket.id);

    io.to(roomId).emit("systemMessage", {
      message: `${nickname} 님이 퇴장했습니다.`,
    });

    if (Object.keys(room.players).length === 0) {
      rooms.delete(roomId);
      return;
    }

    if (room.drawerId === socket.id && room.roundActive) {
      room.roundActive = false;
      io.to(roomId).emit("roundEnded", {
        reason: "출제자가 나갔습니다. 다음 라운드로 넘어갑니다.",
        round: room.round,
      });
      io.to(roomId).emit("clearCanvas");
      io.to(roomId).emit("hintUpdated", { hint: "" });
      setTimeout(() => startRound(roomId), 3000);
    } else {
      broadcastRoomState(roomId);
    }
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Socket 서버 실행 중: http://localhost:${PORT}`);
});
