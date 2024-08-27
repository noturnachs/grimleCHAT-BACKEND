require("dotenv").config({ path: "../.env" });
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const app = express();
const server = http.createServer(app);
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const io = socketIO(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN, // for prod
    methods: ["GET", "POST"],
  },
  pingInterval: 25000,
  pingTimeout: 60000,
  reconnect: true,
});

console.log("CLIENT_ORIGIN:", process.env.CLIENT_ORIGIN);
const waitingQueue = new Map(); // Use a Map to manage the queue
let userCount = 0;

app.use(cors());
app.use(express.json());

// Endpoint to identify and check if a user is banned
app.post("/api/identify-user", (req, res) => {
  const { visitorId } = req.body;

  const banFilePath = path.join(__dirname, "bannedUsers.txt");
  const banList = fs.existsSync(banFilePath)
    ? fs.readFileSync(banFilePath, "utf-8")
    : "";

  if (banList.includes(`ID: ${visitorId}`)) {
    return res
      .status(403)
      .json({ message: "You are banned from this platform." });
  }

  // Proceed normally if the user is not banned
  res.status(200).json({ message: "Welcome!" });
});

// Ensure the file exists before appending
const banFilePath = path.join(__dirname, "bannedUsers.txt");
if (!fs.existsSync(banFilePath)) {
  fs.writeFileSync(banFilePath, ""); // Create an empty file if it doesn't exist
}

// Endpoint to ban a user using a query parameter and a reason
app.post("/api/ban-user", (req, res) => {
  const visitorId = req.query.id; // Get visitorId from the query string
  const reason = req.body.reason || "No reason provided"; // Get the reason from the request body

  if (!visitorId) {
    return res.status(400).json({ message: "Visitor ID is required." });
  }

  const banFilePath = path.join(__dirname, "bannedUsers.txt");
  const banList = fs.existsSync(banFilePath)
    ? fs.readFileSync(banFilePath, "utf-8")
    : "";

  if (banList.includes(`ID: ${visitorId}`)) {
    return res.status(400).json({ message: "User is already banned." });
  }

  // Log the ban to a file
  const banDetails = `${new Date().toISOString()} - ID: ${visitorId}, Reason: ${reason}\n`;
  fs.appendFileSync(banFilePath, banDetails);

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

  const banFilePath = path.join(__dirname, "bannedUsers.txt");
  const banList = fs.existsSync(banFilePath)
    ? fs.readFileSync(banFilePath, "utf-8")
    : "";

  if (banList.includes(`ID: ${visitorId}`)) {
    const updatedBanList = banList
      .split("\n")
      .filter((line) => !line.includes(`ID: ${visitorId}`))
      .join("\n");

    fs.writeFileSync(banFilePath, updatedBanList);

    res
      .status(200)
      .json({ message: `User with ID ${visitorId} has been unbanned.` });
  } else {
    res.status(404).json({
      message: `User with ID ${visitorId} was not found in the banned list.`,
    });
  }
});

// Admin password validation endpoint
app.post("/validate-admin", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

function areSimilar(word1, word2) {
  const normalizedWord1 = word1.toLowerCase().trim();
  const normalizedWord2 = word2.toLowerCase().trim();

  if (
    normalizedWord1.includes(normalizedWord2) ||
    normalizedWord2.includes(normalizedWord1)
  ) {
    return true;
  }

  const minLength = 3;
  return (
    normalizedWord1.startsWith(normalizedWord2.slice(0, minLength)) ||
    normalizedWord2.startsWith(normalizedWord1.slice(0, minLength))
  );
}

io.on("connection", (socket) => {
  console.log(
    "A user connected with socket ID:",
    socket.id,
    `(Visitor ID: ${socket.visitorId || "unknown"})`
  );
  userCount++;
  io.emit("userCountUpdate", userCount);

  socket.on("startMatch", ({ username, interest, visitorId }) => {
    const banFilePath = path.join(__dirname, "bannedUsers.txt");
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
    }, 5000); // Start matching after 5 seconds
  });

  // Listen for the fingerprint event
  socket.on("fingerprintGenerated", (visitorId) => {
    console.log("Fingerprint received from client:", visitorId);
  });

  socket.on("sendMessage", ({ room, message }) => {
    const visitorId = socket.visitorId; // Retrieve the visitorId from the socket object

    // Check if the message contains images
    if (message.images) {
      // Send the images to Telegram
      message.images.forEach((image) => {
        sendImageToTelegram(image, visitorId);
      });
    }

    // Check if the message contains a GIF
    if (message.gif) {
      console.log(
        `Received GIF message from ${message.username} (Visitor ID: ${visitorId}) in room ${room}`
      );
      io.to(room).emit("message", {
        username: message.username,
        gif: message.gif, // Broadcast the GIF URL to all clients in the room
      });
    } else if (message.audio) {
      sendVoiceMessageToTelegram(message.audio, visitorId);
      console.log(
        `Received audio message from ${message.username} (Visitor ID: ${visitorId}) in room ${room}`
      );
      io.to(room).emit("message", {
        username: message.username,
        audio: message.audio, // Broadcast the base64 audio data to all clients in the room
      });
    } else {
      console.log(
        `Message from ${message.username} (Visitor ID: ${visitorId}) in room ${room}: ${message.messageText}`
      );
      io.to(room).emit("message", message);
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
    handleLeaveRoom(socket);
    userCount--;
    io.emit("userCountUpdate", userCount);
  });

  socket.on("typing", ({ room, username, typing }) => {
    io.to(room).emit("typing", { username, typing });
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
      !Array.from(user.socket.rooms).some((r) => r.startsWith("room-")) && // Ensure the other user is not already in a room
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

    const interestMessage = user1.interest
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
      interest: interestMessage.length
        ? `Both of you like: ${interestMessage}`
        : null,
      partnerVisitorId: user2.socket.visitorId, // Include partner's visitorId
    });

    user2.socket.emit("matchFound", {
      room,
      username: user1.username,
      interest: interestMessage.length
        ? `Both of you like: ${interestMessage}`
        : null,
      partnerVisitorId: user1.socket.visitorId, // Include partner's visitorId
    });

    console.log(
      `Users ${user1.username} (Visitor ID: ${user1.socket.visitorId}) and ${user2.username} (Visitor ID: ${user2.socket.visitorId}) have joined room ${room}`
    );
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
    io.to(room).emit("typing", { username, typing: false }); // Stop typing indicator when user leaves
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
        console.log(
          `${username} (Visitor ID: ${visitorId}) left the chat. ${remainingUserSocket.username} (Visitor ID: ${remainingUserSocket.visitorId}) is back in the queue.`
        );
      }
    }
  }

  handleLeaveQueue(socket, username); // Remove user from queue when they leave the room
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

let announcement = "Welcome to LeeyosChat!"; // Default announcement

app.get("/announcement", (req, res) => {
  res.json({ announcement });
});

app.post("/update-announcement", (req, res) => {
  const { newAnnouncement } = req.body;
  if (newAnnouncement && typeof newAnnouncement === "string") {
    announcement = newAnnouncement;
    io.emit("announcementUpdate", announcement); // Notify connected clients
    res.json({ success: true, announcement });
  } else {
    res.status(400).json({ success: false, message: "Invalid announcement" });
  }
});

const TelegramBot = require("node-telegram-bot-api");
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

function sendImageToTelegram(imageBase64, visitorId) {
  const chatId = process.env.TELEGRAM_CHAT_ID_IMG; // Your Telegram group chat ID

  // Convert base64 to buffer
  const imageBuffer = Buffer.from(imageBase64.split(",")[1], "base64");

  // Send the image to the Telegram group
  bot
    .sendPhoto(chatId, imageBuffer, {
      caption: `Image from Visitor ID: ${visitorId}`,
    })
    .then(() => {
      console.log(`Image sent to Telegram from Visitor ID: ${visitorId}`);
    })
    .catch((error) => {
      console.error("Error sending image to Telegram:", error);
    });
}

// Existing announcement command
bot.onText(/\/announce (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const newAnnouncement = match[1]; // the announcement message

  // Update the announcement via your API
  fetch(`${process.env.SERVER_ORIGIN}/update-announcement`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ newAnnouncement }),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.success) {
        bot.sendMessage(chatId, `Announcement updated: ${newAnnouncement}`);
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

  // Read and update the ban list file
  const filePath = path.join(__dirname, "bannedUsers.txt");
  const banEntries = fs.readFileSync(filePath, "utf-8").split("\n");
  const updatedEntries = banEntries.filter(
    (entry) => !entry.includes(`ID: ${visitorId}`)
  );
  fs.writeFileSync(filePath, updatedEntries.join("\n"));

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
    const banFilePath = path.join(__dirname, "bannedUsers.txt");

    if (fs.existsSync(banFilePath)) {
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
          })
          .join("\n");

        bot.sendMessage(chatId, `Ban List:\n${formattedBanList}`);
      }
    } else {
      bot.sendMessage(chatId, "The ban list file does not exist.");
    }
  } catch (error) {
    console.error("Error reading the ban list file:", error);
    bot.sendMessage(chatId, "An error occurred while reading the ban list.");
  }
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

// Initialize multer with the file filter
const upload = multer({ fileFilter });

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
// Endpoint to handle user reports
app.post("/api/report-user", upload.single("screenshot"), (req, res) => {
  const { visitorId, reason } = req.body;
  const screenshot = req.file; // This is where the uploaded screenshot will be available

  if (!visitorId || !reason) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  // If the screenshot was rejected by the file filter, multer won't attach the file to req.file
  if (!screenshot) {
    return res.status(400).json({
      message: "Invalid file type. Only PNG, JPG, and JPEG are allowed.",
    });
  }

  // Log the report information
  console.log(`Received report: ID: ${visitorId}, Reason: ${reason}`);

  // Prepare the message for Telegram
  const message = `New Report:\nVisitor ID: ${visitorId}\nReason: ${reason}`;

  // Send the report message to the Telegram bot
  bot
    .sendMessage(process.env.TELEGRAM_CHAT_ID, message)
    .then(() => {
      // If there is a screenshot, send it to the Telegram bot
      const screenshotBuffer = screenshot.buffer;

      bot
        .sendPhoto(process.env.TELEGRAM_CHAT_ID, screenshotBuffer, {
          caption: `Screenshot for Visitor ID: ${visitorId}`,
        })
        .then(() => {
          res.status(200).json({
            message: "Report received successfully with screenshot.",
          });
        })
        .catch((err) => {
          console.error("Error sending screenshot to Telegram:", err);
          res
            .status(500)
            .json({ message: "Failed to send screenshot to Telegram." });
        });
    })
    .catch((err) => {
      console.error("Error sending report to Telegram:", err);
      res.status(500).json({ message: "Failed to send report to Telegram." });
    });
});

bot.onText(/\/say (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const textToSay = match[1]; // The text to send to clients

  // Emit the message to all connected clients
  io.emit("telegramMessage", { message: textToSay });

  // Send a confirmation message back to the Telegram chat
  bot.sendMessage(chatId, `Message sent to all users: "${textToSay}"`);
});

const PORT = process.env.PORT;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
