const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const fetch = require('node-fetch'); // Ensure you have node-fetch installed
const cors = require('cors');
const axios = require('axios');
const app = express();
const port = 3004;
const server = http.createServer(app);
const io = socketIo(server);
const upload = multer({ dest: 'uploaded-media/' });

app.use(express.json());
app.use(cors());
process.setMaxListeners(100);
let clients = {};


// Function to create or retrieve a client
const createClient = async (clientId) => {
    // Check if the client already exists and is initialized (authenticated)
    if (clients[clientId] && clients[clientId].initialized) {
        return { message: 'Client already authenticated and ready' };
    }

    // Check if client exists but has timed out (no further QR generation)
    if (clients[clientId] && clients[clientId].timeout) {
        return { message: 'QR code generation timed out. Please refresh or try again later.' };
    }

    // Check if client exists but is not yet authenticated
    if (clients[clientId] && !clients[clientId].initialized) {
        return { qr: clients[clientId].qr };
    }

    // Create a new client
    // const client = new Client({
    //     puppeteer: {
    //         headless: true,
    //         args: [
    //             '--no-sandbox',
    //             '--disable-setuid-sandbox',
    //             '--disable-dev-shm-usage',
    //             '--disable-background-timer-throttling',
    //             '--headless=new',
    //             '--disable-infobars',
    //             '--disable-default-apps',
    //             '--disable-popup-blocking',
    //             '--disable-translate',
    //              '--disable-logging'
    //          ]
    //     },
    //     authStrategy: new LocalAuth({ clientId }),
    // });
       const client = new Client({
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-background-timer-throttling',
                    '--disable-infobars',
                    '--disable-default-apps',
                    '--disable-popup-blocking',
                    '--disable-translate',
                     '--disable-logging'
                 ]
            },
            authStrategy: new LocalAuth({ clientId }),
            webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/guigo022/whatsapp-web.js/master/src/webVersionCache.json'
        },
        bypassCSP: true,
        qrMaxRetries: 5
        });
    

    clients[clientId] = { client, qr: null, initialized: false, timeout: false };

    return new Promise((resolve, reject) => {
        client.on('qr', async (qr) => {
            if (!clients[clientId].initialized && !clients[clientId].timeout) {
                try {
                    const qrCodeBuffer = await qrcode.toBuffer(qr);
                    clients[clientId].qr = qrCodeBuffer;
                    io.emit('qrCodeUpdate', { clientId, qr: qrCodeBuffer.toString('base64') });
                    console.log(`QR Code for Client ${clientId} generated.`);

                    setTimeout(() => {
                        if (!clients[clientId].initialized) {
                            clients[clientId].timeout = true;
                            io.emit('qrCodeTimeout', { clientId, message: 'QR code generation timed out. Please generate again.' });
                            console.log(`QR Code for Client ${clientId} timed out.`);
                        }
                    }, 40000);

                    resolve({ qr: qrCodeBuffer });
                } catch (error) {
                    reject(error);
                }
            }
        });

        client.on('authenticated', () => {
            console.log(`Client ${clientId} has been authenticated.`);
            clients[clientId].initialized = true;
            clients[clientId].timeout = false;
            io.emit('clientStatus', { clientId, status: 'authenticated' });
        });

        client.on('ready', async () => {
            console.log(`Client ${clientId} is ready!`);
        
            if (client.info && client.info.wid && client.info.wid.user) {
                const connectedNumber = client.info.wid.user;
                console.log(`Attempting to update agent for connected number: ${connectedNumber}`);
        
                try {
                    const response = await axios.post('https://socialsync.envisionit.io/backend/saveOrUpdateAgentId', {
                        clientId,
                        connectedNumber
                    });
                    console.log('Agent check/update response:', response.data);
                } catch (error) {
                    console.error('Error checking or updating agent:', error);
                }
            } else {
                console.error('Error: client.info.wid.user is not defined');
            }
        });

        // const io = socketIo(server, {
        //     cors: {
        //         origin: 'https://socialsync.envisionit.io',  // Use domain, not IP
        //         methods: ['GET', 'POST'],
        //         allowedHeaders: ['Content-Type'],
        //         credentials: true,
        //     },
        //     transports: ['websocket', 'polling'] // Ensure WebSocket transport is enabled
        // });
        
        const activeConnections = new Set(); // Track all connected users

// SSE Route to Send Live Updates
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    activeConnections.add(res);
    req.on('close', () => activeConnections.delete(res)); // Remove on disconnect
});

// Function to Send SMS Updates to All Users
function sendLiveSMS(sender, receiver, message_body, conversationId, timestamp) {
    const data = JSON.stringify({ sender, receiver, message_body, conversationId, timestamp });
    activeConnections.forEach(user => user.write(`data: ${data}\n\n`));
}
        
        


   async function getProperName(client, id) {
            try {
                const contact = await client.getContactById(id);
                if (contact.pushname && contact.pushname.trim()) return contact.pushname.trim();
                if (contact.name && contact.name.trim()) return contact.name.trim();
                if (contact.verifiedName && contact.verifiedName.trim()) return contact.verifiedName.trim();
            } catch (e) { }
            try {
                const chat = await client.getChatById(id);
                if (chat.name && !chat.name.includes('+92') && chat.name.trim()) return chat.name.trim();
            } catch (e) { }
            return id.split('@')[0];
        }








// YEHI FINAL FUNCTION HAI — HAR MEDIA PE FRESH DATA FETCH HOGA
async function uploadMediaToSocialCRM(media, type, sender, receiver) {
    const FormData = require('form-data');
    const axios = require('axios');

    try {
        const buffer = Buffer.from(media.data, 'base64');

        // Step 1: Fetch agents & users
        let allAgents = [];
        let tokenToCompany = {}; // token → companyname map

        try {
            const [agentsRes, usersRes] = await Promise.all([
                axios.get('https://socialsync.envisionit.io/backend/fetchallagents'),
                axios.get('https://socialsync.envisionit.io/backend/all-users')
            ]);

            allAgents = agentsRes.data || [];
            const usersList = usersRes.data || [];
            console.log(`Fetched ${allAgents.length} agents and ${usersList.length} users`);
            // Correct mapping: token → companyname
            usersList.forEach(user => {
                if (user.token && user.companyname) {
                    tokenToCompany[user.token] = user.companyname.trim();
                }
            });

        } catch (err) {
            console.error("API fetch failed:", err.message);
        }
        // Step 2: Sender/receiver se agent dhundo
        const agentNumber = sender.startsWith('92') ? sender : receiver;

        const agent = allAgents.find(a =>
            a.phone_number === agentNumber ||
            a.phone_number === sender ||
            a.phone_number === receiver
        );

        let companyName = 'default';

        if (agent && agent.authtoken && tokenToCompany[agent.authtoken]) {
            companyName = tokenToCompany[agent.authtoken];
            console.log(`MATCH FOUND → ${agentNumber} → ${companyName}`);
        } else {
            console.log(`NO MATCH → ${agentNumber} → Using default`);
            if (agent) console.log("Agent found but token not in users:", agent.authtoken);
        }

        // Step 3: Upload to media server
        const form = new FormData();
        const ext = getExtension(media.mimetype);
        const filename = `${type}_${sender}_${receiver}_${Date.now()}${ext}`;

        form.append('media', buffer, {
            filename: filename,
            contentType: media.mimetype
        });
        form.append('type', type);
        form.append('sender', sender);
        form.append('receiver', receiver);
        form.append('company', companyName);

        const response = await axios.post(
            'http://75.119.134.139:4000/socialsync/upload',
            form,
            {
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                timeout: 300000
            }
        );

        if (response.data?.success) {
            console.log(`UPLOADED → ${companyName}/${filename}`);
            console.log(`URL of file uplaod : ${response.data.url}`);
            return response.data.url;
        }

        return null;

    } catch (err) {
        console.error("Upload failed:", err.message);
        return null;
    }
}

// Extension helper (safe)
function getExtension(mimetype) {
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'video/mp4': '.mp4',
        'video/3gpp': '.3gp',
        'audio/ogg': '.ogg',
        'audio/mp4': '.m4a',
        'audio/aac': '.aac',
        'application/pdf': '.pdf',
        'text/plain': '.txt'
    };
    return map[mimetype] || '';
}



// Extension helper
function getExtension(mimetype) {
    const map = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
        'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'application/pdf': '.pdf'
    };
    return map[mimetype] || '';
}



client.on('message_create', async (message) => {
    
    try {
        if (message.fromMe && message.to === message.from) return; // Self message ignore
        if (message.id.fromMe && message.id.id === message.id._serialized) return; // Extra safety
        // Ignore Groups, Broadcasts, Newsletters
        if (
            message.from.endsWith('@g.us') || 
            message.to.endsWith('@g.us') || 
            message.from.includes('broadcast') || 
            message.to.includes('broadcast') || 
            message.from.includes('newsletter') || 
            message.to.includes('newsletter')
        ) {
            console.log("Ignore group, broadcast, and newsletter SMS");
            return;
        }

        console.log("New message received:", message.id);

        // YEHI EK LINE BADAL DI — SABSE PEHLE DECLARE KAR DIYE TAake OVERWRITE NA HO!
        let senderNumber = 'unknown';
        let receiverNumber = 'unknown';
        let senderName = 'N/A';
        let receiverName = 'N/A';

        const myNumber = client.info?.wid?._serialized?.split('@')[0] || 'unknown';

        // === SENDER NAME & NUMBER ===
        try {
            const senderContact = await client.getContactById(message.from);
            senderNumber = senderContact.number || senderContact.id.user;
            senderName = senderContact.pushname || 
                        senderContact.name || 
                        senderContact.verifiedName || 
                        senderContact.shortName || 
                        senderNumber;

            console.log("Resolved sender name:", senderName);
            console.log("Resolved sender number:", senderNumber);
        } catch (e) {
            senderNumber = message.from.split('@')[0];
            senderName = senderNumber;
        }
        
        // === RECEIVER NAME & NUMBER ===
        try {
            const receiverContact = await client.getContactById(message.to);
            receiverNumber = receiverContact.number || receiverContact.id.user;
            receiverName = receiverContact.pushname || 
                          receiverContact.name || 
                          receiverContact.verifiedName || 
                          receiverContact.shortName || 
                          receiverNumber;

            console.log("Resolved receiver name:", receiverName);
            console.log("Resolved receiver number:", receiverNumber);
        } catch (e) {
            receiverNumber = message.to.split('@')[0];
            receiverName = receiverNumber;
        }

        // Agar hum bhej rahe hain to sender = hum
        if (message.fromMe || message.from.includes(myNumber)) {
            senderNumber = myNumber;
            // senderName = "Me"; // ya apna naam daal do
        }

        // Agar humein message aaya to receiver = hum
        if (message.to.includes(myNumber)) {
            receiverNumber = myNumber;
            // receiverName = "Me";
        }

        // === Baaki sab kuch bilkul same ===
        let messageBody = message.body || "N/A";

              // ==================== MEDIA HANDLING (FINAL 2025 VERSION) ====================
        if (message.hasMedia) {
            try {
                const media = await message.downloadMedia();
                if (!media) throw new Error("Download failed to download");

                // Detect exact type
                let mediaType = 'document';
                if (media.mimetype.startsWith('image/')) {
                    mediaType = media.mimetype.includes('sticker') ? 'sticker' : 'image';
                } else if (media.mimetype.startsWith('video/')) {
                    mediaType = 'video';
                } else if (media.mimetype.startsWith('audio/')) {
                    mediaType = media.mimetype.includes('ptt') || media.mimetype.includes('ogg') ? 'voicenote' : 'audio';
                } else if (media.mimetype.includes('document') || media.mimetype.includes('pdf') || media.mimetype.includes('msword') || media.mimetype.includes('sheet')) {
                    mediaType = 'document';
                }

                // Upload to SocialCRM Media Server
                const mediaUrl = await uploadMediaToSocialCRM(media, mediaType, senderNumber, receiverNumber);

                if (mediaUrl) {
                    messageBody = `[${mediaType.toUpperCase()}] ${mediaUrl}`;
                    console.log(`MEDIA UPLOADED → ${mediaType.toUpperCase()}: ${mediaUrl}`);
                } else {
                    messageBody = `This is a media: ${mediaType} (upload failed)`;
                }

            } catch (err) {
                console.error("MEDIA PROCESSING FAILED:", err.message);
                messageBody = "This is a media: error";
            }
        }
        // =============================================================================

        const conversationId = [senderNumber, receiverNumber].sort().join('-');
        const timestamp = new Date().toLocaleString('en-US', {
            hour12: true,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            month: '2-digit',
            day: '2-digit',
            year: 'numeric'
        });

        // Final Log
        console.log("════════════════════════════════");
        console.log("Sender      :", senderNumber, "→", senderName);
        console.log("Receiver    :", receiverNumber, "→", receiverName);
        console.log("Message     :", messageBody);
        console.log("Conv ID     :", conversationId);
        console.log("sendername  :", senderName);
        console.log("receivername:", receiverName);
        console.log("════════════════════════════════");

        // Send to frontend + DB
        sendLiveSMS(senderNumber, receiverNumber, messageBody, conversationId, timestamp);
        await saveMessage(senderNumber, receiverNumber, messageBody, conversationId, senderName, receiverName);
        //await chatStatusUpdateOpen(senderNumber, receiverNumber);

    } catch (error) {
        console.error("Error processing message:", error);
    }
});






        client.on("disconnected", async (reason) => {
            await client.destroy();
            const folderPath = path.join(__dirname, `../../../.wwebjs_auth/session-${clientId}`);
            fs.rm(folderPath, { recursive: true, force: true }, (err) => {
                if (err) {
                    console.log(`Error deleting folder: ${err.message}`);
                } else {
                    console.log('LogOut Client:', clientId);

                    try {
                        const response = axios.post('https://socialsync.envisionit.io/backend/resetAgentClientId', {
                            clientId   // Reset the clientId to null or an empty value
                        });
                        console.log('Client ID reset response:', response.data);
                    } catch (error) {
                        console.error('Error resetting clientId:', error);
                    }
                }
            });
        });

        client.initialize().catch((error) => reject(error));
    });
};

const chatStatusUpdateOpen = async (senderNumber, receiverNumber) => {
  try {
      // Log the chat status
      console.log("Updating chat status for:", { senderNumber, receiverNumber });

      // Define the API endpoint (use environment variable or configuration if possible)
      const apiBaseUrl = process.env.API_BASE_URL || 'https://socialsync.envisionit.io/backend';
      const endpoint = `${apiBaseUrl}/chatStatusUpdateOpen`;

      // Send the POST request using Axios
      const response = await axios.post(endpoint, {
          sender: senderNumber,
          receiver: receiverNumber,
      });

      // Handle the success response
      console.log('Chat status updated successfully:', response.data.messageId || response.data);
  } catch (error) {
      // Handle errors
      if (error.response) {
          // Server responded with a status other than 2xx
          console.error('Error saving message:', error.response.data.error || error.response.data);
      } else if (error.request) {
          // Request was made, but no response was received
          console.error('No response received from server:', error.request);
      } else {
          // Something else happened
          console.error('An unexpected error occurred:', error.message);
      }
  }
};


// Function to save message in SQL database
const saveMessage = async (senderNumber, receiverNumber, messageBody, conversationId,senderName,receiverName) => {
    const response = await fetch('https://socialsync.envisionit.io/backend/saveMessage', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            sender: senderNumber,
            receiver: receiverNumber,
            messageBody: messageBody,
            conversationId: conversationId,
            senderName: senderName,
            receiverName: receiverName,
        }),
    });

    const data = await response.json();
    if (response.ok) {
        console.log('Message saved successfully:', data.messageId);
    } else {
        console.error('Error saving message:', data.error);
    }
};

// Endpoint to initialize and display QR code for new clients
app.get('/', async (req, res) => {
    const { id } = req.query;
    if (!id) {
        return res.status(400).json({ error: 'Client ID is required' });
    }

    try {
        const result = await createClient(id);
        let statusMessage = 'Scan the QR Code to connect';

        if (result.message) {
            statusMessage = result.message;
        }

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Client - ${id}</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                img { margin-top: 20px; }
                 p { font-size: 14px; color: #555; }
            </style>
        </head>
        <body>
            <h1>WhatsApp Client ID: ${id}</h1>
            <h2>Status: <span id="status">${statusMessage}</span></h2>
            ${result.qr ? `<img id="qrCode" src="data:image/png;base64,${result.qr.toString('base64')}" alt="Scan this QR code to connect" />` : ''}
              <p>Refresh the page after 20 seconds to check your status.</p>
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();

                socket.on('clientStatus', (data) => {
                    if (data.clientId === '${id}') {
                        const statusElement = document.getElementById('status');
                        if (data.status === 'authenticated') {
                            statusElement.textContent = 'Authenticated. Ready to use!';
                        } else if (data.status === 'ready') {
                            statusElement.textContent = 'Client is ready!';
                            document.getElementById('qrCode').style.display = 'none'; // Hide QR code if ready
                        } else if (data.status === 'loggedOut') {
                            statusElement.textContent = 'You have been logged out from another device.';
                            document.getElementById('qrCode').style.display = 'none'; // Optionally hide QR code
                        }
                    }
                });

                socket.on('qrCodeUpdate', (data) => {
                    if (data.clientId === '${id}') {
                        const qrCodeElement = document.getElementById('qrCode');
                        if (qrCodeElement) {
                            qrCodeElement.src = 'data:image/png;base64,' + data.qr;
                        }
                    }
                });

                socket.on('qrCodeTimeout', (data) => {
                    if (data.clientId === '${id}') {
                        const statusElement = document.getElementById('status');
                        statusElement.textContent = data.message;
                    }
                });
            </script>
        </body>
        </html>
        `;
        res.send(htmlContent);
    } catch (error) {
        console.error('Error creating client or generating QR code:', error.message);
        res.status(500).json({ error: 'Error creating client or generating QR code' });
    }
});

// Endpoint to retrieve the connected number
app.get('/connectedNumber', (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });

    const connectedNumber = clients[clientId]?.connectedNumber;
    if (connectedNumber) {
        res.json({ connectedNumber });
    } else {
        res.status(404).json({ error: 'Client not found or not initialized' });
    }
});

// Endpoint to send a message
// app.post('/sendmessage', async (req, res) => {
//     const { agentNumber, text, toNumber } = req.body;
//     if (!agentNumber || !text || !toNumber) {
//         return res.status(400).json({ error: 'Agent number, text, and recipient number are required' });
//     }
//     try {
//         const recipientNumber = `${toNumber}@c.us`; // Format the number for WhatsApp
//         const result = await sendSMS(agentNumber, text, recipientNumber);
        
//         if (result.success) {
//             return res.status(200).json({ message: 'Message sent successfully', data: result.data });
//         } else {
//             console.error(`Error in sending message: ${result.error}`);
//             return res.status(500).json({ error: `Error sending message: ${result.error}` });
//         }
//     } catch (error) {
//         console.error('Unexpected error occurred while sending message:', error);
//         return res.status(500).json({ error: 'Unexpected error occurred while sending message' });
//     }
// });


// Function to send SMS through WhatsApp
// app.post('/sendmessage', (req, res) => {
//     const { toNumber, text } = req.body;
//     const agentID = '3'; // Hardcoded client ID
//     const client = clients[agentID]?.client; // Access the client object

//     console.log(client); // Debug log to check the client object

//     if (!client || typeof client.sendMessage !== 'function') {
//         return res.status(404).send('Client not found or sendMessage method is not available');
//     }

//     const formattedTo = `${toNumber}@c.us`; // Format the number for WhatsApp

//     // Send the message
//     client.sendMessage(formattedTo, text)
//         .then(response => {
//             console.log(`Message sent to ${toNumber}: ${text}`);
//             res.status(200).send('Message sent successfully');
//         })
//         .catch(err => {
//             console.error(`Error sending message to ${toNumber}:`, err);
//             res.status(500).send('Error sending message');
//         });
// });








app.post('/sendmessage', async (req, res) => {
    const { toNumber, text, clientId } = req.body;

    // Validate required fields
    if (!toNumber || !text || !clientId) {
        return res.status(400).json({ error: 'Missing required fields: toNumber, text, or clientId' });
    }

    // Retrieve the client using the dynamic clientId
    const client = clients[clientId]?.client;

    if (!client || typeof client.sendMessage !== 'function') {
        return res.status(404).json({ error: 'Client not found or sendMessage method is not available' });
    }

    const formattedTo = `${toNumber}@c.us`; // Format the number for WhatsApp

    try {
        const response = await client.sendMessage(formattedTo, text);

        // Check if the response contains unexpected HTML/JavaScript
        if (typeof response === 'string' && response.includes('<script')) {
            console.warn('Unexpected HTML response:', response);
            return res.status(500).json({ error: 'Unexpected response format from API' });
        }

        // Log and return a success message
        console.log(`Message sent to ${toNumber}: ${text}`);
        res.status(200).json({
            message: 'Message sent successfully',
            details: response,
        });
    } catch (err) {
        // Log and return error details
        console.error(`Error sending message to ${toNumber}:`, err);
        res.status(500).json({
            error: 'Failed to send message',
            details: err.message,
        });
    }
})


// Start the server
server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
