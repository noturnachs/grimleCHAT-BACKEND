require("dotenv").config({ path: "../.env" });
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const TelegramBot = require("node-telegram-bot-api");
const { Sequelize } = require("sequelize");
const dbConfig = require("./database");

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: [
      process.env.CLIENT_ORIGIN,
      "https://lcccc.onrender.com",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
  },
  pingInterval: 25000,
  pingTimeout: 60000,
  reconnect: true,
});

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(cors());
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const roomLastActivity = {};
let userCount = 0;
let waitingQueue = new Map();
let createdRooms = [];
let roomMessages = {};
let announcement = "Welcome to LeeyosChat!"; // Default announcement

// Multer configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["image/png", "image/jpeg", "image/jpg"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true); // Accept the file
  } else {
    cb(
      new Error("Invalid file type. Only PNG, JPG, and JPEG are allowed."),
      false
    ); // Reject the file
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
});

const diskPath =
  process.env.NODE_ENV === "production"
    ? "/mnt/uploadsFolder" // This is the mount path you set on Render
    : "uploadsFolder"; // Local path for development

// Ensure the uploads folder exists
if (!fs.existsSync(diskPath)) {
  fs.mkdirSync(diskPath); // Create the uploads folder if it doesn't exist
}

// Set the path for the banned users file
const banFilePath = path.join(diskPath, "bannedUsers.txt");
if (!fs.existsSync(banFilePath)) {
  fs.writeFileSync(banFilePath, ""); // Create an empty file if it doesn't exist
}

// Set the path for the stickers file
const stickersFilePath = path.join(diskPath, "stickers.txt");
if (!fs.existsSync(stickersFilePath)) {
  fs.writeFileSync(stickersFilePath, ""); // Create an empty file if it doesn't exist
}

console.log("CLIENT_ORIGIN:", process.env.CLIENT_ORIGIN);

app.use(cors());
app.use(express.json());

// Add Helmet middleware for security headers
const helmet = require("helmet");

// Apply Helmet middleware with HSTS configuration
app.use(helmet());
app.use(
  helmet.hsts({
    maxAge: 31536000, // 1 year in seconds
    includeSubDomains: true,
    preload: true,
  })
);
const roomChatLogs = new Map(); // Store chat logs for each room
let peakUserCount = 0;

app.get("/api/stats", (req, res) => {
  try {
    // Update peak user count if current count is higher
    if (userCount > peakUserCount) {
      peakUserCount = userCount;
    }

    const stats = {
      activeUsers: userCount,
      peakUsers: peakUserCount,
      activeRooms: createdRooms.length,
    };

    res.json(stats);
  } catch (error) {
    console.error("Error fetching system stats:", error);
    res.status(500).json({ message: "Failed to fetch system stats" });
  }
});

// Utility function to check if a user is banned
const isUserBanned = (visitorId) => {
  if (!fs.existsSync(banFilePath)) {
    return false; // If the file doesn't exist, the user is not banned
  }

  const data = fs.readFileSync(banFilePath, "utf-8");
  return data.split("\n").some((line) => line.includes(`ID: ${visitorId}`));
};

// Utility function to ban a user
const banUser = (visitorId, reason) => {
  const banDetails = `${new Date().toISOString()} - ID: ${visitorId}, Reason: ${reason}\n`;
  fs.appendFileSync(banFilePath, banDetails); // Append to the ban file
};

// Utility function to unban a user
const unbanUser = (visitorId) => {
  const banEntries = fs.readFileSync(banFilePath, "utf-8").split("\n");
  const updatedEntries = banEntries.filter(
    (entry) => !entry.includes(`ID: ${visitorId}`)
  );
  fs.writeFileSync(banFilePath, updatedEntries.join("\n")); // Write the updated list back to the file
};

function updateRoomActivity(room) {
  roomLastActivity[room] = Date.now();
}

// Endpoint to identify and check if a user is banned
app.post("/api/identify-user", (req, res) => {
  const { visitorId } = req.body;

  // Validate visitorId
  if (!visitorId || typeof visitorId !== "string") {
    return res.status(400).json({ message: "Invalid visitor ID." });
  }

  // Check if the visitorId is in the ban list
  if (isUserBanned(visitorId)) {
    console.log(`Visitor ID ${visitorId} is banned.`);
    return res
      .status(403)
      .json({ message: "You are banned from this platform." });
  }

  console.log(`Visitor ID ${visitorId} is not banned.`);
  // Proceed normally if the user is not banned
  res.status(200).json({ message: "Welcome!" });
});

// Endpoint to ban a user using a query parameter and a reason
app.post("/api/ban-user", (req, res) => {
  const visitorId = req.query.id; // Get visitorId from the query string
  const reason = req.body.reason || "No reason provided"; // Get the reason from the request body

  if (!visitorId) {
    return res.status(400).json({ message: "Visitor ID is required." });
  }

  if (isUserBanned(visitorId)) {
    return res.status(400).json({ message: "User is already banned." });
  }

  // Ban the user
  banUser(visitorId, reason);
  res.status(200).json({
    message: `User with ID ${visitorId} has been banned. Reason: ${reason}`,
  });
});

// Endpoint to unban a user using a query parameter
app.post("/api/unban-user", (req, res) => {
  const visitorId = req.query.id; // Get visitorId from the query string

  if (!visitorId) {
    return res.status(400).json({ message: "Visitor ID is required." });
  }

  if (!isUserBanned(visitorId)) {
    return res.status(404).json({
      message: `User with ID ${visitorId} was not found in the banned list.`,
    });
  }

  // Unban the user
  unbanUser(visitorId);
  res
    .status(200)
    .json({ message: `User with ID ${visitorId} has been unbanned.` });
});

function areSimilar(str1, str2) {
  return (
    str1.toLowerCase().includes(str2.toLowerCase()) ||
    str2.toLowerCase().includes(str1.toLowerCase())
  );
}

let currentYouTubeLink = "https://www.youtube.com/watch?v=GemKqzILV4w"; // Default link

const INACTIVITY_TIMEOUT = process.env.INACTIVITY_TIMEOUT || 10 * 60 * 1000; // Default to 10 minutes

function checkInactiveRooms() {
  const now = Date.now();

  for (const room in roomLastActivity) {
    if (now - roomLastActivity[room] > INACTIVITY_TIMEOUT) {
      const sockets = io.sockets.adapter.rooms.get(room);
      if (sockets) {
        for (const socketId of sockets) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.emit("roomClosed", {
              message: "Room closed due to inactivity",
            });
            handleLeaveRoom(socket);
          }
        }
      }
      delete roomLastActivity[room];
      delete roomMessages[room];
      const roomIndex = createdRooms.indexOf(room);
      if (roomIndex !== -1) {
        createdRooms.splice(roomIndex, 1);
      }
      console.log(`Room ${room} closed due to inactivity`);
    }
  }
}

const INACTIVITY_WARNING_TIMEOUT = 3 * 60 * 1000; // 3 minutes in milliseconds
function checkInactiveRoomsAndWarn() {
  const now = Date.now();

  for (const room in roomLastActivity) {
    const inactiveTime = now - roomLastActivity[room];

    if (
      inactiveTime > INACTIVITY_WARNING_TIMEOUT &&
      inactiveTime <= INACTIVITY_TIMEOUT
    ) {
      const sockets = io.sockets.adapter.rooms.get(room);
      if (sockets) {
        for (const socketId of sockets) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.emit("inactivityWarning", {
              message:
                "Warning: This room will be closed in 2 minutes due to inactivity.",
            });
          }
        }
      }
    }
  }
}

io.on("connection", (socket) => {
  console.log(
    "A user connected with socket ID:",
    socket.id,
    `(Visitor ID: ${socket.visitorId || "unknown"})`
  );

  socket.on("fetchMissedMessages", ({ room, lastMessageTimestamp }) => {
    if (roomMessages[room]) {
      const missedMessages = roomMessages[room].filter(
        (msg) => msg.timestamp > lastMessageTimestamp
      );
      socket.emit("missedMessages", missedMessages);
    }
  });

  // Add this with your other socket event handlers
  socket.on("requestUserCount", () => {
    // Calculate current user count
    const currentCount = io.sockets.sockets.size;
    // Send the count back to the requesting client
    socket.emit("userCountUpdate", currentCount);
  });

  socket.on("messageReaction", ({ room, messageId, reaction, username }) => {
    // Get or initialize room messages array
    if (!roomMessages[room]) {
      roomMessages[room] = [];
    }

    const messages = roomMessages[room];
    const messageIndex = messages.findIndex((msg) => msg.id === messageId);

    if (messageIndex !== -1) {
      // Initialize reactions if they don't exist
      if (!messages[messageIndex].reactions) {
        messages[messageIndex].reactions = {};
      }

      // Initialize reaction array if it doesn't exist
      if (!messages[messageIndex].reactions[reaction]) {
        messages[messageIndex].reactions[reaction] = [];
      }

      const users = messages[messageIndex].reactions[reaction];

      // Toggle user's reaction
      const userIndex = users.indexOf(username);
      if (userIndex === -1) {
        users.push(username);
      } else {
        users.splice(userIndex, 1);
      }

      // Remove reaction if no users
      if (users.length === 0) {
        delete messages[messageIndex].reactions[reaction];
      }

      // Emit updated message to all users in room
      io.to(room).emit("messageReactionUpdate", {
        messageId,
        reactions: messages[messageIndex].reactions,
      });
    }
  });

  socket.on("rejoinRoom", ({ room, username, visitorId }) => {
    socket.join(room);
    socket.to(room).emit("userRejoined", { username, visitorId });
  });

  socket.on("unsendMessage", ({ room, messageId }) => {
    console.log(`Attempting to unsend message ${messageId} in room ${room}`);

    // Find and update the message in roomMessages if it exists
    if (roomMessages[room]) {
      const messageIndex = roomMessages[room].findIndex(
        (msg) => msg.id === messageId
      );
      if (messageIndex !== -1) {
        // Clear the reactions for this message
        roomMessages[room][messageIndex].reactions = {};
      }
    }

    // Emit to all clients in the room that the message was unsent
    io.to(room).emit("messageUnsent", {
      messageId: messageId,
    });
  });

  // Add this new event listener for reconnection
  socket.on("userReconnected", ({ username, visitorId, room }) => {
    console.log(
      `User ${username} (Visitor ID: ${visitorId}) reconnected to room ${room}`
    );

    // Rejoin the room
    socket.join(room);

    // Fetch recent messages for the room
    const recentMessages = roomMessages[room]
      ? roomMessages[room].slice(-20)
      : [];

    // Send recent messages to the reconnected user
    socket.emit("reconnectionMessages", recentMessages);

    // Notify other users in the room about the reconnection
    socket.to(room).emit("userReconnected", { username, visitorId });
  });

  socket.emit("updateYouTubeLink", currentYouTubeLink);
  userCount++;
  io.emit("userCountUpdate", userCount);

  // Listen for the triggerEffect event
  socket.on("triggerEffect", ({ effect, room }) => {
    console.log(`Effect triggered: ${effect} in room: ${room}`);
    // Emit the confettiTriggered event to all clients in the specified room
    io.to(room).emit("confettiTriggered");
  });

  socket.on("startMatch", ({ username, interest, visitorId }) => {
    if (!visitorId) {
      socket.emit("error", {
        message: "Please refresh page and try again.",
      });
      return;
    }
    const banList = fs.existsSync(banFilePath)
      ? fs.readFileSync(banFilePath, "utf-8")
      : "";

    // Check if the visitorId is in the ban list
    if (banList.includes(`ID: ${visitorId}`)) {
      socket.emit("banned", { message: "You are banned from this platform." });
      return;
    }

    // Set the visitorId on the socket object
    socket.visitorId = visitorId;

    // Proceed with matching logic if not banned
    if (!Array.isArray(interest) || interest.length === 0) {
      interest = ["No interest provided"];
    }

    // Log the fingerprint (visitorId) along with username and interest
    console.log(
      `User ${username} (Visitor ID: ${visitorId}) with interests: ${interest.join(
        ", "
      )}`
    );

    for (let [socketId, user] of waitingQueue.entries()) {
      if (user.socket.visitorId === visitorId) {
        waitingQueue.delete(socketId);
        console.log(`Removed duplicate entry for Visitor ID: ${visitorId}`);
      }
    }

    if (waitingQueue.has(socket.id)) {
      console.log(
        `User ${username} (Visitor ID: ${visitorId}) is already in the waiting queue`
      );
      return;
    }

    socket.username = username;
    socket.interest = interest;
    waitingQueue.set(socket.id, {
      socket,
      username,
      interest,
      joinedAt: Date.now(),
    });
    console.log(
      "Current waiting queue:",
      Array.from(waitingQueue.values()).map(
        (user) =>
          `${user.username} (Visitor ID: ${
            user.socket.visitorId
          }) (${user.interest.join(", ")})`
      )
    );

    setTimeout(() => {
      matchUsers(socket);
    }, 2000); // Start matching after 5 seconds
  });

  // Endpoint to get messages from a specific room and all available rooms
  app.get("/api/messages/:room", (req, res) => {
    const { room } = req.params;

    // Check if there are messages for the specified room
    if (roomMessages[room]) {
      res.status(200).json({
        success: true,
        messages: roomMessages[room].map((msg) => ({
          username: msg.username,
          messageText: msg.messageText,
          visitorId: msg.visitorId, // Include the visitorId in the response
          timestamp: msg.timestamp,
        })),
        rooms: createdRooms,
      });
    } else {
      res.status(404).json({
        success: false,
        message: "Room not found.",
        rooms: createdRooms,
      });
    }
  });

  // Listen for the fingerprint event
  socket.on("fingerprintGenerated", (visitorId) => {
    console.log("Fingerprint received from client:", visitorId);
  });

  socket.on("sendMessage", ({ room, message }) => {
    updateRoomActivity(room);
    const visitorId = socket.visitorId;
    const timestamp = message.timestamp || Date.now();

    // Store the message in the roomMessages object
    if (!roomMessages[room]) {
      roomMessages[room] = []; // Initialize the array if it doesn't exist
    }

    // Create the message object with all necessary properties
    const messageWithMetadata = {
      ...message,
      id:
        message.id ||
        `msg_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp,
      visitorId,
      reactions: {}, // Initialize empty reactions object
    };

    // Push message to room messages only once
    roomMessages[room].push(messageWithMetadata);

    if (!roomChatLogs.has(room)) {
      roomChatLogs.set(room, []);
    }
    roomChatLogs.get(room).push({
      timestamp: new Date().toISOString(),
      username: message.username,
      messageText: message.messageText || "",
      gif: message.gif || null,
      sticker: message.sticker || null,
      images: message.images || null,
      audio: message.audio || null,
    });

    // Emit the appropriate message based on type
    if (message.gif) {
      io.to(room).emit("message", {
        ...messageWithMetadata,
        username: message.username,
        gif: message.gif,
      });
    } else if (message.audio) {
      sendVoiceMessageToTelegram(message.audio, visitorId);
      io.to(room).emit("message", {
        ...messageWithMetadata,
        username: message.username,
        audio: message.audio,
      });
    } else if (
      message.messageText &&
      typeof message.messageText === "string" &&
      message.messageText.trim() !== ""
    ) {
      io.to(room).emit("message", messageWithMetadata);
      console.log(
        `Message from ${
          message.username
        } (Visitor ID: ${visitorId}) in room ${room} at ${new Date(
          timestamp
        ).toISOString()}: ${message.messageText}`
      );
    } else {
      io.to(room).emit("message", messageWithMetadata);
    }

    // Handle images if present
    if (message.images) {
      message.images.forEach((image) => {
        sendImageToTelegram(image, visitorId);
      });
    }
  });

  socket.on("leaveRoom", () => {
    handleLeaveRoom(socket);
  });

  socket.on("leaveQueue", (username) => {
    handleLeaveQueue(socket, username);
  });

  socket.on("disconnect", () => {
    console.log(
      `User with socket ID ${socket.id} (Visitor ID: ${socket.visitorId}) disconnected`
    );
    // Don't remove the user from the room immediately
    // Instead, set a timeout to remove them if they don't reconnect
    setTimeout(() => {
      const rooms = Array.from(socket.rooms);
      const room = rooms.find((r) => r.startsWith("room-"));
      if (room && !io.sockets.adapter.rooms.get(room).has(socket.id)) {
        handleLeaveRoom(socket);
      }
    }, 30000); // 30 seconds timeout
    userCount--;
    io.emit("userCountUpdate", userCount);
  });

  socket.on("typing", ({ room, username, typing }) => {
    io.to(room).emit("typing", { username, typing });
  });
});

// Endpoint to get the list of available rooms
app.get("/api/rooms", (req, res) => {
  res.status(200).json({
    success: true,
    rooms: createdRooms,
    roomAdmins: roomAdmins, // Include the roomAdmins object in the response
  });
});

function matchUsers(socket) {
  // Check if the user is already in a room
  const rooms = Array.from(socket.rooms);
  const currentRoom = rooms.find((r) => r.startsWith("room-"));

  if (currentRoom) {
    console.log(
      `User ${socket.username} (Visitor ID: ${socket.visitorId}) is already in a room: ${currentRoom}`
    );
    return; // Exit if the user is already in a room
  }

  let user1, user2;

  // First, try to match based on interests
  const matchIndex = Array.from(waitingQueue.values()).findIndex(
    (user) =>
      user.socket.id !== socket.id &&
      user.socket.visitorId !== socket.visitorId && // Add this line to prevent self-matching
      !Array.from(user.socket.rooms).some((r) => r.startsWith("room-")) &&
      user.interest.some((userInterest) =>
        socket.interest.some((currentInterest) =>
          areSimilar(userInterest, currentInterest)
        )
      )
  );

  if (matchIndex !== -1) {
    user1 = waitingQueue.get(socket.id);
    user2 = Array.from(waitingQueue.values())[matchIndex];
    waitingQueue.delete(user2.socket.id);
  } else {
    // If no match is found based on interests, fallback to random matching
    const randomMatchIndex = Array.from(waitingQueue.values()).findIndex(
      (user) =>
        user.socket.id !== socket.id &&
        user.socket.visitorId !== socket.visitorId && // Add this line to prevent self-matching
        !Array.from(user.socket.rooms).some((r) => r.startsWith("room-"))
    );

    if (randomMatchIndex !== -1) {
      user1 = waitingQueue.get(socket.id);
      user2 = Array.from(waitingQueue.values())[randomMatchIndex];
      waitingQueue.delete(user2.socket.id);
      console.log(
        `Fallback random match between ${user1?.username} (Visitor ID: ${user1?.socket.visitorId}) and ${user2?.username} (Visitor ID: ${user2?.socket.visitorId})`
      );
    }
  }

  if (user1 && user2) {
    const room = `room-${user1.username}-${user2.username}`;

    // Add the created room to the createdRooms array
    createdRooms.push(room);

    console.log(
      `Matching ${user1.username} (Visitor ID: ${user1.socket.visitorId}) and ${user2.username} (Visitor ID: ${user2.socket.visitorId}) in room ${room}`
    );

    // Remove user1 from the waiting queue
    waitingQueue.delete(user1.socket.id);
    console.log(
      `${user1.username} (Visitor ID: ${user1.socket.visitorId}) removed from the waiting queue`
    );
    console.log(
      `${user2.username} (Visitor ID: ${user2.socket.visitorId}) removed from the waiting queue`
    );

    user1.socket.join(room);
    user2.socket.join(room);

    const interestMessage =
      user1.interest[0] === "No interest provided" ||
      user2.interest[0] === "No interest provided"
        ? null
        : user1.interest
            .filter((user1Interest) =>
              user2.interest.some((user2Interest) =>
                areSimilar(user1Interest, user2Interest)
              )
            )
            .map((interest) => `<strong>${interest}</strong>`)
            .join(", ");

    // Emit matchFound event to both users, including their respective visitorIds
    user1.socket.emit("matchFound", {
      room,
      username: user2.username,
      interest: interestMessage ? `Both of you like: ${interestMessage}` : null,
      partnerVisitorId: user2.socket.visitorId,
      matchType: matchIndex !== -1 ? "interest" : "random",
    });

    user2.socket.emit("matchFound", {
      room,
      username: user1.username,
      interest: interestMessage ? `Both of you like: ${interestMessage}` : null,
      partnerVisitorId: user1.socket.visitorId,
      matchType: matchIndex !== -1 ? "interest" : "random",
    });

    console.log(
      `Users ${user1.username} (Visitor ID: ${user1.socket.visitorId}) and ${user2.username} (Visitor ID: ${user2.socket.visitorId}) have joined room ${room}`
    );

    // Initialize room activity
    updateRoomActivity(room);
  } else {
    console.log(
      `No match found for user ${socket.username} (Visitor ID: ${socket.visitorId}).`
    );
  }
}

function handleLeaveRoom(socket) {
  const username = socket.username;
  const visitorId = socket.visitorId;
  const rooms = Array.from(socket.rooms);
  const room = rooms.find((r) => r.startsWith("room-"));
  if (room) {
    socket.leave(room);
    io.to(room).emit("typing", { username, typing: false });
    io.to(room).emit("message", {
      username: "System",
      messageText: `${username} (Visitor ID: ${visitorId}) has left the chat.`,
    });

    const remainingUsers = Array.from(io.sockets.adapter.rooms.get(room) || []);
    if (remainingUsers.length === 1) {
      const remainingUserSocketId = remainingUsers[0];
      const remainingUserSocket = io.sockets.sockets.get(remainingUserSocketId);
      if (remainingUserSocket) {
        remainingUserSocket.emit("userLeft", {
          message: `${username} (Visitor ID: ${visitorId}) has left the chat. You are back in the queue.`,
          username: username,
        });
        remainingUserSocket.leave(room);
      }
    }

    // Clear room messages
    delete roomMessages[room];
    roomChatLogs.delete(room);

    // Remove the room from createdRooms
    const roomIndex = createdRooms.indexOf(room);
    if (roomIndex !== -1) {
      createdRooms.splice(roomIndex, 1);
      console.log(`Room ${room} has been removed from createdRooms.`);
    }
  }

  handleLeaveQueue(socket, username);
}

function handleLeaveQueue(socket, username) {
  if (waitingQueue.has(socket.id)) {
    console.log(
      `Removing user ${username} (Visitor ID: ${socket.visitorId}) from the waiting queue`
    );
    waitingQueue.delete(socket.id);
  }
  console.log(
    "Current waiting queue after leaving:",
    Array.from(waitingQueue.values()).map(
      (user) => `${user.username} (Visitor ID: ${user.socket.visitorId})`
    )
  );
}

app.get("/announcement", (req, res) => {
  res.json({ announcement });
});

// Submit vote
// Submit vote
app.post("/api/vote", async (req, res) => {
  const { visitorId, choice, isChange } = req.body;

  try {
    await sequelize.transaction(async (t) => {
      if (isChange) {
        // Get the user's current vote
        const [currentVote] = await sequelize.query(
          "SELECT choice FROM public.video_votes WHERE visitor_id = :visitorId",
          {
            replacements: { visitorId },
            type: Sequelize.QueryTypes.SELECT,
            transaction: t,
          }
        );

        if (currentVote) {
          // Get current counts before updating
          const [currentCounts] = await sequelize.query(
            "SELECT yes_count, no_count FROM public.vote_counts WHERE id = 1",
            {
              type: Sequelize.QueryTypes.SELECT,
              transaction: t,
            }
          );

          // Only decrease if count is greater than 0
          if (currentCounts[`${currentVote.choice}_count`] > 0) {
            await sequelize.query(
              `UPDATE public.vote_counts 
               SET ${currentVote.choice}_count = ${currentVote.choice}_count - 1 
               WHERE id = 1`,
              {
                type: Sequelize.QueryTypes.UPDATE,
                transaction: t,
              }
            );
          }

          // Update user's vote
          await sequelize.query(
            `UPDATE public.video_votes 
             SET choice = :choice 
             WHERE visitor_id = :visitorId`,
            {
              replacements: { visitorId, choice },
              type: Sequelize.QueryTypes.UPDATE,
              transaction: t,
            }
          );
        } else {
          // If no current vote found, insert new vote
          await sequelize.query(
            `INSERT INTO public.video_votes (visitor_id, choice) 
             VALUES (:visitorId, :choice)`,
            {
              replacements: { visitorId, choice },
              type: Sequelize.QueryTypes.INSERT,
              transaction: t,
            }
          );
        }
      } else {
        // Insert new vote
        await sequelize.query(
          `INSERT INTO public.video_votes (visitor_id, choice) 
           VALUES (:visitorId, :choice)`,
          {
            replacements: { visitorId, choice },
            type: Sequelize.QueryTypes.INSERT,
            transaction: t,
          }
        );
      }

      // Increment the new choice count
      await sequelize.query(
        `UPDATE public.vote_counts 
         SET ${choice}_count = ${choice}_count + 1 
         WHERE id = 1`,
        {
          type: Sequelize.QueryTypes.UPDATE,
          transaction: t,
        }
      );
    });

    // Get final counts
    const [voteCounts] = await sequelize.query(
      "SELECT yes_count, no_count FROM public.vote_counts WHERE id = 1",
      {
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    // Emit update to all clients
    io.emit("voteUpdate", {
      yes: voteCounts.yes_count,
      no: voteCounts.no_count,
    });

    res.json({
      success: true,
      votes: {
        yes: voteCounts.yes_count,
        no: voteCounts.no_count,
      },
    });
  } catch (error) {
    console.error("Database error:", error);
    if (error.name === "SequelizeUniqueConstraintError") {
      res.status(400).json({ error: "You have already voted" });
    } else {
      res.status(500).json({ error: "Error submitting vote" });
    }
  }
});

// Update the check-vote endpoint to include the user's current vote
app.post("/api/check-vote", async (req, res) => {
  const { visitorId } = req.body;

  try {
    const [userVote] = await sequelize.query(
      "SELECT choice FROM public.video_votes WHERE visitor_id = :visitorId",
      {
        replacements: { visitorId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    const [voteCounts] = await sequelize.query(
      "SELECT yes_count, no_count FROM public.vote_counts WHERE id = 1",
      {
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    res.json({
      hasVoted: !!userVote,
      currentVote: userVote?.choice || null,
      votes: {
        yes: voteCounts.yes_count,
        no: voteCounts.no_count,
      },
    });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Error checking vote status" });
  }
});

// Update the announcement endpoint
app.post("/update-announcement", (req, res) => {
  const { newAnnouncement } = req.body;
  if (newAnnouncement && typeof newAnnouncement === "string") {
    announcement = newAnnouncement.replace(/\\n/g, "\n");
    io.emit("announcementUpdate", announcement);
    res.json({ success: true, announcement });
  } else {
    res.status(400).json({ success: false, message: "Invalid announcement" });
  }
});

async function sendImageToTelegram(imageData, visitorId) {
  const chatId = process.env.TELEGRAM_CHAT_ID_IMG; // Your Telegram group chat ID

  let imageBuffer;

  try {
    if (imageData instanceof ArrayBuffer) {
      // If it's an ArrayBuffer, convert it directly to a Buffer
      imageBuffer = Buffer.from(imageData);
    } else if (imageData instanceof Blob) {
      // If it's a Blob, convert it to an ArrayBuffer first
      const arrayBuffer = await imageData.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    } else if (typeof imageData === "string") {
      // If it's a base64 string
      const base64Data = imageData.includes(",")
        ? imageData.split(",")[1]
        : imageData;
      imageBuffer = Buffer.from(base64Data, "base64");
    } else if (Buffer.isBuffer(imageData)) {
      // If it's already a Buffer
      imageBuffer = imageData;
    } else if (
      typeof imageData === "object" &&
      imageData.buffer instanceof ArrayBuffer
    ) {
      // If it's a typed array (like Uint8Array)
      imageBuffer = Buffer.from(imageData.buffer);
    } else {
      console.error(
        "Unexpected image data format:",
        typeof imageData,
        imageData
      );
      return;
    }

    // Send the image to the Telegram group
    await bot.sendPhoto(chatId, imageBuffer, {
      caption: `Image from Visitor ID: ${visitorId}`,
    });

    console.log(`Image sent to Telegram from Visitor ID: ${visitorId}`);
  } catch (error) {
    console.error("Error sending image to Telegram:", error);
  }
}

// Existing announcement command
bot.onText(/\/announce (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const newAnnouncement = match[1];
  const telegramFormatted = parseColorTagsForTelegram(newAnnouncement);
  const clientFormatted = parseColorTagsForClient(newAnnouncement);

  // Update the announcement via your API
  fetch(`${process.env.SERVER_ORIGIN}/update-announcement`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ newAnnouncement: clientFormatted }),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.success) {
        bot.sendMessage(chatId, `Announcement updated: ${telegramFormatted}`, {
          parse_mode: "HTML",
        });
      } else {
        bot.sendMessage(chatId, `Failed to update announcement.`);
      }
    })
    .catch((error) => {
      bot.sendMessage(chatId, `Error: ${error.message}`);
    });
});
// New ban command with reason (reason is optional)
bot.onText(/\/ban (\S+)(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const visitorId = match[1].trim(); // The visitor ID to ban
  const reason = match[2] ? match[2].trim() : "No reason provided"; // The reason for the ban, or "No reason provided" if none

  if (!visitorId) {
    bot.sendMessage(chatId, "Visitor ID is required to ban a user.");
    return;
  }

  // Get the current date and time
  const banDate = new Date().toISOString();

  // Send POST request to your server to ban the user using fetch
  try {
    const response = await fetch(
      `${process.env.SERVER_ORIGIN}/api/ban-user?id=${visitorId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason, banDate }), // Send the reason and ban date in the request body
      }
    );

    const data = await response.json();
    if (data.message) {
      bot.sendMessage(chatId, data.message); // Send the server response to the chat
    } else {
      bot.sendMessage(chatId, `Failed to ban user with ID ${visitorId}.`);
    }
  } catch (error) {
    console.error("Error banning user:", error);
    bot.sendMessage(chatId, `An error occurred while banning the user.`);
  }
});

// New unban command
bot.onText(/\/unban (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const visitorId = match[1].trim(); // the visitor ID to unban

  console.log(`Received /unban command with ID: ${visitorId}`); // Log the command

  if (!visitorId) {
    bot.sendMessage(chatId, "Visitor ID is required to unban a user.");
    console.log("Visitor ID was not provided.");
    return;
  }

  // Use the correct path for the banned users file
  const banEntries = fs.readFileSync(banFilePath, "utf-8").split("\n");
  const updatedEntries = banEntries.filter(
    (entry) => !entry.includes(`ID: ${visitorId}`)
  );
  fs.writeFileSync(banFilePath, updatedEntries.join("\n"));

  bot.sendMessage(
    chatId,
    `User with ID ${visitorId} has been successfully unbanned.`
  );
  console.log(`User with ID ${visitorId} has been unbanned.`);
});

// Command to show the list of banned users
bot.onText(/\/banlist/, (msg) => {
  const chatId = msg.chat.id;

  try {
    // Read the banned users file
    const banList = fs.readFileSync(banFilePath, "utf-8");

    if (banList.trim().length === 0) {
      bot.sendMessage(chatId, "The ban list is currently empty.");
    } else {
      const formattedBanList = banList
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line, index) => {
          // Split the line using the "-" and "," delimiters
          const [datePart, idPart] = line.split(" - ID: ");
          const [id, reasonPart] = idPart.split(", Reason: ");

          const date = new Date(datePart).toISOString().split("T")[0];
          const reason = reasonPart || "No reason provided";

          return `${index + 1}. ${date} ${id} ${reason}`;
        });

      // Join the formatted list into a single string
      const fullMessage = `Ban List:\n${formattedBanList.join("\n")}`;

      // Split the message into chunks of 4096 characters
      const maxMessageLength = 4096;
      for (let i = 0; i < fullMessage.length; i += maxMessageLength) {
        const chunk = fullMessage.substring(i, i + maxMessageLength);
        bot.sendMessage(chatId, chunk);
      }
    }
  } catch (error) {
    console.error("Error reading the ban list file:", error);
    bot.sendMessage(chatId, "An error occurred while reading the ban list.");
  }
});

function sendVoiceMessageToTelegram(audioBase64, visitorId) {
  const chatId = process.env.TELEGRAM_CHAT_ID_IMG; // Your Telegram group chat ID

  // Convert base64 to buffer
  const audioBuffer = Buffer.from(audioBase64.split(",")[1], "base64");

  // Create temporary files for the audio
  const tempAudioFile = path.join(__dirname, "tempAudio.webm");
  const tempMp3File = path.join(__dirname, "tempAudio.mp3");

  // Write the audio buffer to a temporary file
  fs.writeFileSync(tempAudioFile, audioBuffer);

  // Convert the audio to MP3 format
  ffmpeg(tempAudioFile)
    .setFfmpegPath(ffmpegPath) // Set the path to ffmpeg
    .toFormat("mp3")
    .on("end", () => {
      // Read the MP3 file and send it to Telegram
      const mp3Buffer = fs.readFileSync(tempMp3File);
      bot
        .sendAudio(chatId, mp3Buffer, {
          caption: `Voice message from Visitor ID: ${visitorId}`,
        })
        .then(() => {
          console.log(
            `Voice message sent to Telegram from Visitor ID: ${visitorId}`
          );
          // Clean up temporary files
          fs.unlinkSync(tempAudioFile); // Remove the temporary WebM file
          fs.unlinkSync(tempMp3File); // Remove the temporary MP3 file
        })
        .catch((error) => {
          console.error("Error sending voice message to Telegram:", error);
          // Clean up temporary files even if sending fails
          fs.unlinkSync(tempAudioFile);
          fs.unlinkSync(tempMp3File);
        });
    })
    .on("error", (error) => {
      console.error("Error converting audio to MP3:", error);
      // Clean up temporary files if conversion fails
      fs.unlinkSync(tempAudioFile);
    })
    .save(tempMp3File); // Save the converted MP3 file
}

// Endpoint to handle bug reports
app.post("/api/reportbugs", upload.single("screenshot"), (req, res) => {
  const { email, issueDescription, selectedProblem } = req.body;
  const screenshot = req.file; // This will contain the uploaded file

  // Validate the incoming data
  if (!email || !issueDescription || !selectedProblem) {
    return res.status(400).json({ message: "All fields are required." });
  }

  // Log the bug report information
  console.log(
    `Received bug report: Email: ${email}, Issue: ${issueDescription}, Problem: ${selectedProblem}`
  );

  // Prepare the message for Telegram
  const message = `New Bug Report:\nEmail: ${email}\nIssue Description: ${issueDescription}\nProblem: ${selectedProblem}`;

  // Send the report message to the Telegram bot
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // If a screenshot is provided, send it along with the message
  if (screenshot) {
    const imageBuffer = screenshot.buffer; // Get the image buffer

    // Send the message and the image to Telegram
    bot
      .sendPhoto(chatId, imageBuffer, { caption: message })
      .then(() => {
        res.status(200).json({ message: "Bug report received successfully." });
      })
      .catch((err) => {
        console.error("Error sending bug report to Telegram:", err);
        res
          .status(500)
          .json({ message: "Failed to send bug report to Telegram." });
      });
  } else {
    // If no screenshot, just send the message
    bot
      .sendMessage(chatId, message)
      .then(() => {
        res.status(200).json({ message: "Bug report received successfully." });
      })
      .catch((err) => {
        console.error("Error sending bug report to Telegram:", err);
        res
          .status(500)
          .json({ message: "Failed to send bug report to Telegram." });
      });
  }
});

function findUsernameByVisitorId(visitorId) {
  for (const [_, socket] of io.sockets.sockets) {
    if (socket.visitorId === visitorId) {
      return socket.username || "Unknown User";
    }
  }
  return "Unknown User";
}

app.post("/api/report-user", upload.single("screenshot"), async (req, res) => {
  const { visitorId, reason, room, reportedByVisitorId } = req.body; // Add reportedByVisitorId to destructuring
  const screenshot = req.file;

  if (!visitorId || !reason || !reportedByVisitorId) {
    // Add validation for reportedByVisitorId
    return res.status(400).json({ message: "Missing required fields." });
  }

  const reportedUsername = findUsernameByVisitorId(visitorId);

  try {
    // Update the INSERT query to include reported_by_visitorid
    const [[report]] = await sequelize.query(
      `INSERT INTO user_reports (
        visitor_id, 
        reported_username, 
        reason, 
        room, 
        status, 
        reported_by_visitorid
      )
      VALUES (
        :visitorId, 
        :reportedUsername, 
        :reason, 
        :room, 
        'pending',
        :reportedByVisitorId
      )
      RETURNING id, visitor_id, reported_username, reason, room, status, reported_by_visitorid`,
      {
        replacements: {
          visitorId,
          reportedUsername,
          reason,
          room,
          reportedByVisitorId,
        },
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    // Handle chat log if available
    let chatLogContent = null;
    if (room && roomChatLogs.has(room)) {
      const chatLog = roomChatLogs.get(room);
      chatLogContent = chatLog
        .map(
          (msg) =>
            `[${msg.timestamp}] ${msg.username}: ${
              msg.messageText ||
              (msg.gif && "[GIF]") ||
              (msg.sticker && "[STICKER]") ||
              (msg.images && "[IMAGE]") ||
              (msg.audio && "[AUDIO]") ||
              "[EMPTY MESSAGE]"
            }`
        )
        .join("\n");

      // Update report with chat log
      await sequelize.query(
        `UPDATE user_reports 
         SET chat_log = :chatLog 
         WHERE id = :reportId`,
        {
          replacements: {
            chatLog: chatLogContent,
            reportId: report.id,
          },
          type: Sequelize.QueryTypes.UPDATE,
        }
      );
    }

    // Handle screenshot if available
    if (screenshot) {
      await sequelize.query(
        `UPDATE user_reports 
         SET screenshot_url = :screenshotUrl 
         WHERE id = :reportId`,
        {
          replacements: {
            screenshotUrl: `/uploads/screenshots/${screenshot.filename}`,
            reportId: report.id,
          },
          type: Sequelize.QueryTypes.UPDATE,
        }
      );
    }

    // Send to Telegram
    await bot.sendMessage(
      process.env.TELEGRAM_CHAT_ID,
      `New Report (#${report.id}):
Reported User: ${reportedUsername} (ID: ${visitorId})
Reported By: Visitor ID: ${reportedByVisitorId}
Reason: ${reason}`
    );

    if (chatLogContent) {
      const tempFilePath = path.join(diskPath, `${room}_chatlog.txt`);
      fs.writeFileSync(tempFilePath, chatLogContent, "utf8");
      await bot.sendDocument(process.env.TELEGRAM_CHAT_ID, tempFilePath, {
        caption: `Chat log for reported user: ${reportedUsername}`,
      });
      fs.unlinkSync(tempFilePath);
    }

    if (screenshot) {
      await bot.sendPhoto(process.env.TELEGRAM_CHAT_ID, screenshot.buffer, {
        caption: `Screenshot for User: ${reportedUsername} (Visitor ID: ${visitorId})`,
      });
    }

    res.status(200).json({ message: "Report received successfully." });
  } catch (err) {
    console.error("Error processing report:", err);
    res.status(500).json({ message: "Failed to process report." });
  }
});

// Add this endpoint to handle admin requests
app.post("/api/admin/request", async (req, res) => {
  const { room, reason, visitorId, username } = req.body;

  try {
    // Log the request to the database
    const [result] = await sequelize.query(
      `INSERT INTO admin_requests 
       (room, reason, visitor_id, username, status, created_at) 
       VALUES (:room, :reason, :visitorId, :username, 'pending', NOW())
       RETURNING id`,
      {
        replacements: { room, reason, visitorId, username },
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    // Notify admins through Telegram
    const message =
      `🚨 *Admin Request*\n\n` +
      `*Room:* ${room}\n` +
      `*User:* ${username}\n` +
      `*Visitor ID:* ${visitorId}\n` +
      `*Reason:* ${reason}`;

    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
    });

    // Notify users in the room that admin has been requested
    io.to(room).emit("message", {
      username: "System",
      messageText: "An admin has been requested and will join shortly.",
      timestamp: new Date(),
      isSystem: true,
    });

    // Add a notification in the room messages
    if (!roomMessages[room]) {
      roomMessages[room] = [];
    }
    roomMessages[room].push({
      id: Date.now().toString(),
      username: "System",
      messageText: "An admin has been requested and will join shortly.",
      timestamp: new Date(),
      isSystem: true,
    });

    res.json({
      success: true,
      message: "Admin request submitted successfully",
      requestId: result.id,
    });
  } catch (error) {
    console.error("Error processing admin request:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process admin request",
    });
  }
});

// Add endpoint to get admin request history
app.get("/api/admin/requests", async (req, res) => {
  try {
    const [requests] = await sequelize.query(
      `SELECT * FROM admin_requests 
       ORDER BY created_at DESC`
    );
    res.json(requests);
  } catch (error) {
    console.error("Error fetching admin requests:", error);
    res.status(500).json({ message: "Failed to fetch admin requests" });
  }
});

// Add endpoint to update admin request status
app.put("/api/admin/requests/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const { status, adminResponse } = req.body;

  try {
    await sequelize.query(
      `UPDATE admin_requests 
       SET status = :status, 
           admin_response = :adminResponse,
           resolved_at = CASE 
             WHEN :status IN ('resolved', 'rejected') THEN NOW() 
             ELSE resolved_at 
           END
       WHERE id = :requestId`,
      {
        replacements: {
          requestId: parseInt(requestId),
          status,
          adminResponse,
        },
      }
    );

    res.json({
      success: true,
      message: "Admin request updated successfully",
    });
  } catch (error) {
    console.error("Error updating admin request:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update admin request",
    });
  }
});

// Add this new endpoint for user report history
app.get("/api/reports/history/:visitorId", async (req, res) => {
  const { visitorId } = req.params;

  try {
    const [reports] = await sequelize.query(
      `SELECT 
        id,
        visitor_id,
        reported_username,
        reason,
        room,
        status,
        action_taken,
        reported_by_visitorid,
        created_at,
        resolved_at,
        resolved_by
       FROM user_reports 
       WHERE reported_by_visitorid = :visitorId
       ORDER BY created_at DESC`,
      {
        replacements: { visitorId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    // Ensure we always return an array
    const reportsArray = Array.isArray(reports)
      ? reports
      : reports
      ? [reports]
      : [];
    res.json(reportsArray);
  } catch (error) {
    console.error("Error fetching report history:", error);
    res.status(500).json({ message: "Failed to fetch report history" });
  }
});

// Get all reports
app.get("/api/admin/reports", async (req, res) => {
  try {
    const [reports] = await sequelize.query(
      `SELECT * FROM user_reports ORDER BY created_at DESC`
    );
    res.json(reports);
  } catch (error) {
    console.error("Error fetching reports:", error);
    res.status(500).json({ message: "Failed to fetch reports" });
  }
});

// Update report status and take action
app.post("/api/admin/reports/:reportId/resolve", async (req, res) => {
  const { reportId } = req.params;
  const { action, adminUsername } = req.body;

  try {
    await sequelize.query(
      `UPDATE user_reports 
       SET status = 'resolved', 
           resolved_at = CURRENT_TIMESTAMP, 
           resolved_by = :adminUsername,
           action_taken = :action
       WHERE id = :reportId`,
      {
        replacements: {
          reportId: parseInt(reportId),
          adminUsername,
          action,
        },
        type: Sequelize.QueryTypes.UPDATE,
      }
    );

    res.json({ message: "Report resolved successfully" });
  } catch (error) {
    console.error("Error resolving report:", error);
    res.status(500).json({ message: "Failed to resolve report" });
  }
});

// Helper function to parse custom color tags
function parseColorTagsForTelegram(text) {
  const colorMap = {
    red: "❤️",
    green: "💚",
    blue: "💙",
    yellow: "💛",
    purple: "💜",
    orange: "🧡",
    black: "🖤",
    white: "🤍",
  };

  const colorRegex = /<(\w+)>(.*?)<\/\1>/g;
  return text.replace(colorRegex, (match, color, content) => {
    return `${colorMap[color.toLowerCase()] || ""}<b>${content}</b>`;
  });
}

function parseColorTagsForClient(text) {
  const colorRegex = /<(\w+)>(.*?)<\/\1>/g;
  return text.replace(colorRegex, (match, color, content) => {
    return `<span style="color: ${color}">${content}</span>`;
  });
}
// Update the /say command
bot.onText(/\/say (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const textToSay = match[1];
  const telegramFormatted = parseColorTagsForTelegram(textToSay);
  const clientFormatted = parseColorTagsForClient(textToSay);

  // Emit the message to all connected clients, preserving HTML
  io.emit("telegramMessage", { message: clientFormatted, isHtml: true });

  // Send a confirmation message back to the Telegram chat
  bot.sendMessage(chatId, `Message sent to all users: ${telegramFormatted}`, {
    parse_mode: "HTML",
  });
});

// Add this new endpoint for admin broadcasts
app.post("/api/admin/broadcast", (req, res) => {
  const { message } = req.body;

  // Emit to all clients using the same telegramMessage event
  io.emit("telegramMessage", {
    message: message,
    isHtml: false,
  });

  res.json({ success: true, message: "Message broadcast successfully" });
});
// Function to load stickers from the text file
const loadStickers = () => {
  if (fs.existsSync(stickersFilePath)) {
    const data = fs.readFileSync(stickersFilePath, "utf-8");
    return data.split("\n").filter((url) => url.trim() !== ""); // Filter out empty lines
  }
  return [];
};

// Load stickers when the server starts
let stickers = loadStickers();

// Ensure the ban file exists
if (!fs.existsSync(banFilePath)) {
  fs.writeFileSync(banFilePath, ""); // Create an empty file if it doesn't exist
}

// Ensure the stickers file exists
const ensureStickersFileExists = () => {
  if (!fs.existsSync(stickersFilePath)) {
    fs.writeFileSync(stickersFilePath, ""); // Create an empty file if it doesn't exist
  }
};

// Call the function to ensure the file exists
ensureStickersFileExists();

app.post("/add-sticker", (req, res) => {
  const { stickerUrl } = req.body;

  if (stickerUrl && !stickers.includes(stickerUrl)) {
    stickers.push(stickerUrl);
    io.emit("new-sticker", stickerUrl);

    // Append the new sticker URL to the text file
    fs.appendFileSync(stickersFilePath, `${stickerUrl}\n`);

    res
      .status(200)
      .send({ success: true, message: "Sticker added successfully" });
  } else {
    res
      .status(400)
      .send({ success: false, message: "Invalid or duplicate sticker URL" });
  }
});

// Endpoint to get the list of stickers
app.get("/api/stickers", (req, res) => {
  try {
    if (fs.existsSync(stickersFilePath)) {
      const data = fs.readFileSync(stickersFilePath, "utf-8");
      const stickers = data.split("\n").filter((url) => url.trim() !== ""); // Filter out empty lines
      res.status(200).json({ success: true, stickers });
    } else {
      res
        .status(404)
        .json({ success: false, message: "Stickers file not found." });
    }
  } catch (error) {
    console.error("Error reading stickers file:", error);
    res
      .status(500)
      .json({ success: false, message: "Error reading stickers." });
  }
});

// bot.onText(/\/song (.+)/, (msg, match) => {
//   const chatId = msg.chat.id;
//   const ytLink = match[1].trim(); // Extract the YouTube link

//   if (!ytLink) {
//     bot.sendMessage(chatId, "Please provide a valid YouTube link.");
//     return;
//   }

//   // Update the current YouTube link
//   currentYouTubeLink = ytLink;

//   // Emit the event to update the YouTube link for all connected clients
//   io.emit("updateYouTubeLink", currentYouTubeLink);

//   // Send a confirmation message back to the Telegram chat
//   bot.sendMessage(chatId, `YouTube link updated to: ${ytLink}`);
// });

bot.onText(/\/addstix (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const stickerUrl = match[1];

  console.log("Received command with URL:", stickerUrl);

  if (stickerUrl) {
    fetch(`${process.env.SERVER_ORIGIN}/add-sticker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stickerUrl }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          bot.sendMessage(chatId, "Sticker added successfully!");
        } else {
          bot.sendMessage(chatId, "Failed to add sticker. Please try again.");
        }
      })
      .catch((error) => {
        bot.sendMessage(chatId, `Error: ${error.message}`);
      });
  } else {
    bot.sendMessage(chatId, "Please provide a valid sticker URL.");
  }
});

// Admin join room command
// Variable to store the current room for each admin
const adminRooms = {};

// Add this endpoint for admin panel room closure
app.post("/api/close-room", (req, res) => {
  try {
    const { room } = req.body;

    if (!room) {
      return res.status(400).json({ message: "Room name is required" });
    }

    // Get all sockets in the room
    const sockets = io.sockets.adapter.rooms.get(room);
    if (sockets) {
      // Notify all users in the room that it's being closed by admin
      io.to(room).emit("roomClosed", {
        message: "This room has been closed by an administrator.",
      });

      // Disconnect all users from the room
      for (const socketId of sockets) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.leave(room);
        }
      }
    }

    // Clear room messages
    delete roomMessages[room];

    // Remove the room from createdRooms
    const roomIndex = createdRooms.indexOf(room);
    if (roomIndex !== -1) {
      createdRooms.splice(roomIndex, 1);
    }

    // Remove the room from roomAdmins tracking
    if (roomAdmins[room]) {
      delete roomAdmins[room];
      // Broadcast updated room admins to all admin clients
      io.emit("roomAdminsUpdate", roomAdmins);
    }

    res.json({ success: true, message: `Room "${room}" has been closed.` });
  } catch (error) {
    console.error("Error closing room:", error);
    res.status(500).json({ message: "Failed to close room" });
  }
});

// Admin end room command
bot.onText(/\/endroom/, (msg) => {
  const chatId = msg.chat.id;
  const room = adminRooms[chatId];

  if (!room) {
    bot.sendMessage(chatId, "You are not currently in any room.");
    return;
  }

  // Get all sockets in the room
  const sockets = io.sockets.adapter.rooms.get(room);
  if (sockets) {
    // Notify all users in the room that it's being closed by admin
    io.to(room).emit("roomClosed", {
      message: "This room has been closed by an administrator.",
    });

    // Disconnect all users from the room
    for (const socketId of sockets) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.leave(room);
      }
    }
  }

  // Clear room messages
  delete roomMessages[room];

  // Remove the room from createdRooms
  const roomIndex = createdRooms.indexOf(room);
  if (roomIndex !== -1) {
    createdRooms.splice(roomIndex, 1);
  }

  // Remove the room from adminRooms
  delete adminRooms[chatId];

  bot.sendMessage(chatId, `Room "${room}" has been closed.`);
});

bot.onText(/\/joinroom (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const room = match[1].trim();

  if (!room) {
    bot.sendMessage(chatId, "Please provide a room name.");
    return;
  }

  // Check if the room exists
  if (!io.sockets.adapter.rooms.has(room)) {
    bot.sendMessage(chatId, `Room "${room}" does not exist.`);
    return;
  }

  // Store the room for this admin
  adminRooms[chatId] = room;

  // Notify clients in the room that an admin has joined
  io.to(room).emit("adminJoined", { room });

  bot.sendMessage(
    chatId,
    `Joined room "${room}". You can now send messages using /adminsay <message>`
  );
});

// Admin send message command
bot.onText(/\/adminsay (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const message = match[1];
  const room = adminRooms[chatId];

  if (!room) {
    bot.sendMessage(
      chatId,
      "You need to join a room first using /joinroom <room_name>"
    );
    return;
  }

  if (!message || message.trim() === "") {
    bot.sendMessage(chatId, "Please provide a non-empty message.");
    return;
  }

  // Send the admin message to the specific room
  io.to(room).emit("adminMessage", {
    username: "Admin",
    messageText: message,
    isAdmin: true,
  });

  bot.sendMessage(chatId, `Admin message sent to room ${room}: ${message}`);
});

bot.onText(/\/leaveroom/, (msg) => {
  const chatId = msg.chat.id;
  const room = adminRooms[chatId];

  if (!room) {
    bot.sendMessage(chatId, "You are not currently in any room.");
    return;
  }

  // Notify clients in the room that the admin has left
  io.to(room).emit("adminLeft", { room });

  // Remove the room for this admin
  delete adminRooms[chatId];

  bot.sendMessage(chatId, `Left room "${room}".`);
});

bot.onText(/\/listrooms/, (msg) => {
  const chatId = msg.chat.id;
  const rooms = Array.from(io.sockets.adapter.rooms.keys()).filter((room) =>
    room.startsWith("room-")
  );

  if (rooms.length === 0) {
    bot.sendMessage(chatId, "There are no active rooms at the moment.");
  } else {
    const roomList = rooms.join("\n");
    bot.sendMessage(chatId, `Active rooms:\n${roomList}`);
  }
});

// Initialize Sequelize with your config (add this after your other const declarations)
const env = process.env.NODE_ENV || "development";
const sequelize = new Sequelize(dbConfig[env].url, {
  dialect: "postgres",
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
  logging: false, // Set to console.log to see SQL queries
});

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Database connection has been established successfully.");
  } catch (error) {
    console.error("Unable to connect to the database:", error);
  }
})();

// Add this with your other endpoints
// Replace the existing validate-special-username endpoint
// Modify the existing endpoint to check if username exists in user_effects
app.post("/api/validate-special-username", async (req, res) => {
  const { username, token } = req.body;

  try {
    const [results] = await sequelize.query(
      "SELECT username, style_effect FROM user_effects WHERE username = :username AND token = :token",
      {
        replacements: { username: username.toLowerCase(), token },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!results) {
      // Check if it's a special username without correct token
      const [specialUsername] = await sequelize.query(
        "SELECT username FROM user_effects WHERE username = :username",
        {
          replacements: { username: username.toLowerCase() },
          type: Sequelize.QueryTypes.SELECT,
        }
      );

      if (specialUsername) {
        return res.json({
          success: false,
          message: "Invalid token for this special username.",
          isVerified: true, // Add this to indicate the username is special
        });
      }

      // Not a special username at all
      return res.json({
        success: true,
        isVerified: false,
      });
    }

    // Valid special username with correct token
    res.json({
      success: true,
      isVerified: true,
      style: results.style_effect,
    });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({
      success: false,
      message: "Error validating username.",
      isVerified: false,
    });
  }
});

// Add a new endpoint to get all verified usernames
app.get("/api/verified-users", async (req, res) => {
  try {
    const results = await sequelize.query("SELECT username FROM user_effects", {
      type: Sequelize.QueryTypes.SELECT,
    });

    const verifiedUsers = results.map((result) => result.username);
    res.json({ verifiedUsers });
  } catch (error) {
    console.error("Error fetching verified users:", error);
    res.status(500).json({ error: "Failed to fetch verified users" });
  }
});

// Add user effect
app.post("/api/admin/user-effects/add", async (req, res) => {
  const { username, token, effect } = req.body;
  try {
    await sequelize.query(
      `INSERT INTO user_effects (username, token, style_effect) 
       VALUES (:username, :token, :effect)
       ON CONFLICT (username) 
       DO UPDATE SET token = :token, style_effect = :effect`,
      {
        replacements: { username, token, effect },
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit user effect
app.put("/api/admin/user-effects/edit", async (req, res) => {
  const { username, effect } = req.body;
  try {
    await sequelize.query(
      `UPDATE user_effects 
       SET style_effect = :effect 
       WHERE username = :username`,
      {
        replacements: { username, effect },
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete user effect
app.delete("/api/admin/user-effects/delete", async (req, res) => {
  const { username } = req.body;
  try {
    await sequelize.query(
      `DELETE FROM user_effects WHERE username = :username`,
      {
        replacements: { username },
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a new endpoint to get user effects
app.get("/api/user-effects", async (req, res) => {
  try {
    const results = await sequelize.query(
      "SELECT username, style_effect FROM user_effects",
      {
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    const effectsMap = results.reduce((acc, effect) => {
      acc[effect.username] = effect.style_effect;
      return acc;
    }, {});

    res.json({
      styles: {
        usernames: effectsMap,
      },
    });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ message: "Error fetching user effects." });
  }
});

bot.onText(/\/clearbanned/, (msg) => {
  const chatId = msg.chat.id;

  try {
    // Clear the ban file by writing an empty string to it
    fs.writeFileSync(banFilePath, "");

    bot.sendMessage(chatId, "All banned users have been cleared successfully.");
    console.log("Ban list has been cleared.");
  } catch (error) {
    console.error("Error clearing ban list:", error);
    bot.sendMessage(chatId, "An error occurred while clearing the ban list.");
  }
});

const COMMANDS_LIST = `
Available Commands:

🔨 *Moderation:*
/ban [visitorID] [reason] - Ban a user with optional reason
/unban [visitorID] - Unban a user
/banlist - Show list of banned users
/clearbanned - Clear all banned users

💬 *Chat Management:*
/joinroom [roomName] - Join a specific chat room
/leaveroom - Leave current room
/listrooms - Show all active rooms
/endroom - End/close current room
/adminsay [message] - Send message as admin to current room

📢 *Announcements:*
/announce [message] - Set a new announcement
/say [message] - Send a message to all users

🎨 *Customization:*
/addstix [url] - Add a new sticker URL

❓ *Help:*
/cmds or /help - Show this command list
`;

// Update the command handler to use Markdown
bot.onText(/\/(cmds|help)/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId, COMMANDS_LIST, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
});

// Add this endpoint near your other API endpoints
app.get("/api/banned-users", (req, res) => {
  try {
    const banList = fs.readFileSync(banFilePath, "utf-8");

    if (banList.trim().length === 0) {
      return res.json([]);
    }

    const bannedUsers = banList
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [datePart, idPart] = line.split(" - ID: ");
        const [id, reasonPart] = idPart.split(", Reason: ");

        return {
          id: id,
          bannedAt: new Date(datePart).toISOString(),
          banReason: reasonPart || "No reason provided",
          username: `User ${id.slice(0, 6)}...`, // Create a shortened version of the ID as username
        };
      });

    res.json(bannedUsers);
  } catch (error) {
    console.error("Error reading ban list:", error);
    res.status(500).json({ error: "Failed to fetch banned users" });
  }
});

// Add this function to reset the 24-hour counter
const resetDailyShoutoutCount = async () => {
  try {
    // This query will only count shoutouts from the last 24 hours
    // No need to manually reset anything
    console.log("Daily shoutout count reset check completed");
  } catch (error) {
    console.error("Error in daily shoutout reset:", error);
  }
};

// Run the reset check every hour
setInterval(resetDailyShoutoutCount, 3600000); // 3600000ms = 1 hour

// Modify the GET endpoint to only fetch active (non-deleted) shoutouts
app.get("/api/shoutouts", async (req, res) => {
  try {
    const [shoutouts] = await sequelize.query(
      `SELECT * FROM shoutouts 
       WHERE deleted = false 
       ORDER BY created_at DESC 
       LIMIT 50`
    );
    res.json({ shoutouts });
  } catch (error) {
    console.error("Error fetching shoutouts:", error);
    res.status(500).json({ message: "Failed to fetch shoutouts" });
  }
});

// Add this endpoint to get all shoutouts for admin panel
app.get("/api/admin/shoutouts", async (req, res) => {
  try {
    const [shoutouts] = await sequelize.query(
      `SELECT * FROM shoutouts 
       ORDER BY created_at DESC`
    );
    res.json(shoutouts); // Return all shoutouts, including deleted ones
  } catch (error) {
    console.error("Error fetching shoutouts for admin:", error);
    res.status(500).json({ message: "Failed to fetch shoutouts" });
  }
});

// Reset shoutout count for a specific visitor
app.post("/api/admin/shoutouts/reset/:visitorId", async (req, res) => {
  const { visitorId } = req.params;
  try {
    await sequelize.query(
      `DELETE FROM shoutouts 
       WHERE visitor_id = :visitorId 
       AND created_at > NOW() - INTERVAL '24 hours'`,
      {
        replacements: { visitorId },
      }
    );
    res.json({ success: true, message: "Shoutout count reset successfully" });
  } catch (error) {
    console.error("Error resetting shoutout count:", error);
    res.status(500).json({ message: "Failed to reset shoutout count" });
  }
});

// Modify the bonus shoutouts endpoint
app.post("/api/admin/shoutouts/bonus/:visitorId", async (req, res) => {
  const { visitorId } = req.params;
  const { bonusCount } = req.body;
  try {
    // Replace the existing bonus count instead of adding to it
    await sequelize.query(
      `INSERT INTO bonus_shoutouts (visitor_id, bonus_count) 
       VALUES (:visitorId, :bonusCount)
       ON CONFLICT (visitor_id) 
       DO UPDATE SET bonus_count = :bonusCount`, // Changed this line
      {
        replacements: { visitorId, bonusCount },
      }
    );
    res.json({
      success: true,
      message: "Bonus shoutouts updated successfully",
    });
  } catch (error) {
    console.error("Error updating bonus shoutouts:", error);
    res.status(500).json({ message: "Failed to update bonus shoutouts" });
  }
});

// Add this endpoint to manually delete a shoutout
app.put("/api/shoutouts/:id/delete", async (req, res) => {
  const { id } = req.params;
  try {
    await sequelize.query(
      `UPDATE shoutouts 
       SET deleted = true, 
           deletion_date = NOW() 
       WHERE id = :id`,
      {
        replacements: { id },
      }
    );
    res.json({ success: true, message: "Shoutout marked as deleted" });
  } catch (error) {
    console.error("Error deleting shoutout:", error);
    res.status(500).json({ message: "Failed to delete shoutout" });
  }
});

// Add this function to automatically mark old shoutouts as deleted
const markOldShoutoutsAsDeleted = async () => {
  try {
    await sequelize.query(
      `UPDATE shoutouts 
       SET deleted = true, 
           deletion_date = NOW() 
       WHERE created_at < NOW() - INTERVAL '20 minutes' 
       AND deleted = false`
    );
    console.log("Cleaned up old shoutouts");
  } catch (error) {
    console.error("Error marking old shoutouts as deleted:", error);
  }
};

// Add this near the top of your server file, after your other imports and setup
// Run the cleanup every minute
setInterval(markOldShoutoutsAsDeleted, 60000); // 60000ms = 1 minute

// Check remaining shoutouts for a visitor
app.get("/api/shoutouts/remaining/:visitorId", async (req, res) => {
  try {
    const { visitorId } = req.params;
    const [results] = await sequelize.query(
      `WITH daily_count AS (
        SELECT COUNT(*) as used_count
        FROM shoutouts 
        WHERE visitor_id = :visitorId 
        AND created_at > NOW() - INTERVAL '24 hours'
      ),
      bonus_count AS (
        SELECT COALESCE(bonus_count, 0) as bonus_shoutouts
        FROM bonus_shoutouts
        WHERE visitor_id = :visitorId
      )
      SELECT 
        daily_count.used_count,
        COALESCE(bonus_count.bonus_shoutouts, 0) as bonus_shoutouts
      FROM daily_count
      LEFT JOIN bonus_count ON true`,
      {
        replacements: { visitorId },
      }
    );

    const usedCount = parseInt(results[0].used_count);
    const bonusShoutouts = parseInt(results[0].bonus_shoutouts);
    const totalAllowed = 5 + bonusShoutouts;
    const remaining = Math.max(0, totalAllowed - usedCount);

    res.json({ remaining });
  } catch (error) {
    console.error("Error checking remaining shoutouts:", error);
    res.status(500).json({ message: "Failed to check remaining shoutouts" });
  }
});

// Post a new shoutout
app.post("/api/shoutouts", async (req, res) => {
  try {
    const { message, visitorId } = req.body;

    // Check remaining shoutouts including bonus shoutouts
    const [results] = await sequelize.query(
      `WITH daily_count AS (
        SELECT COUNT(*) as used_count
        FROM shoutouts 
        WHERE visitor_id = :visitorId 
        AND created_at > NOW() - INTERVAL '24 hours'
      ),
      bonus_count AS (
        SELECT COALESCE(bonus_count, 0) as bonus_shoutouts
        FROM bonus_shoutouts
        WHERE visitor_id = :visitorId
      )
      SELECT 
        daily_count.used_count,
        COALESCE(bonus_count.bonus_shoutouts, 0) as bonus_shoutouts
      FROM daily_count
      LEFT JOIN bonus_count ON true`,
      {
        replacements: { visitorId },
      }
    );

    const usedCount = parseInt(results[0].used_count);
    const bonusShoutouts = parseInt(results[0].bonus_shoutouts);
    const totalAllowed = 5 + bonusShoutouts;

    if (usedCount >= totalAllowed) {
      return res
        .status(429)
        .json({ message: "Shoutout limit reached for today" });
    }

    // Insert new shoutout
    await sequelize.query(
      `INSERT INTO shoutouts (visitor_id, message) 
       VALUES (:visitorId, :message)`,
      {
        replacements: { visitorId, message },
      }
    );

    res.status(201).json({
      message: "Shoutout posted successfully",
      remainingShoutouts: totalAllowed - usedCount - 1,
    });
  } catch (error) {
    console.error("Error posting shoutout:", error);
    res.status(500).json({ message: "Failed to post shoutout" });
  }
});

// Add these endpoints after your other API endpoints
const roomAdmins = {};

// Update the admin join room endpoint
app.post("/api/admin/join-room", (req, res) => {
  const { room, adminUsername } = req.body;

  if (!room || !adminUsername) {
    return res
      .status(400)
      .json({ message: "Room name and admin username are required" });
  }

  // Check if the room exists
  if (!io.sockets.adapter.rooms.has(room)) {
    return res.status(404).json({ message: "Room does not exist" });
  }

  // Check if room is already being managed
  if (roomAdmins[room]) {
    return res.status(400).json({
      message: `Room is already being managed by ${roomAdmins[room]}`,
    });
  }

  // Assign admin to room
  roomAdmins[room] = adminUsername;

  // Notify all users in the room that an admin has joined
  io.to(room).emit("adminJoined", { room, adminUsername });

  // Broadcast updated room admins to all admin clients
  io.emit("roomAdminsUpdate", roomAdmins);

  res.json({ success: true, message: `Joined room "${room}"` });
});

// Update the admin leave room endpoint
app.post("/api/admin/leave-room", (req, res) => {
  const { room, adminUsername } = req.body;

  if (!room || !adminUsername) {
    return res
      .status(400)
      .json({ message: "Room name and admin username are required" });
  }

  // Remove admin from room
  delete roomAdmins[room];

  // Notify all users in the room that the admin has left
  io.to(room).emit("adminLeft", { room, adminUsername });

  // io.to(room).emit("message", {
  //   username: "System",
  //   messageText: "An administrator has left the room.",
  //   timestamp: new Date(),
  //   isSystem: true,
  // });

  // Broadcast updated room admins to all admin clients
  io.emit("roomAdminsUpdate", roomAdmins);

  res.json({ success: true, message: `Left room "${room}"` });
});

// Admin send message endpoint
app.post("/api/admin/send-message", (req, res) => {
  const { room, message } = req.body;

  if (!room || !message) {
    return res.status(400).json({ message: "Room and message are required" });
  }

  // Send the admin message to the specific room
  io.to(room).emit("message", {
    username: "Admin",
    messageText: message,
    timestamp: new Date(),
    isAdmin: true,
  });

  // Store the message in roomMessages
  if (!roomMessages[room]) {
    roomMessages[room] = [];
  }

  roomMessages[room].push({
    username: "Admin",
    messageText: message,
    timestamp: new Date(),
    isAdmin: true,
  });

  res.json({ success: true, message: "Message sent successfully" });
});

const PORT = process.env.PORT || 3002; // Default to 3000 if PORT is not set
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

setInterval(checkInactiveRoomsAndWarn, 60000); // Check every minute
setInterval(checkInactiveRooms, 60000); // Check every minute
