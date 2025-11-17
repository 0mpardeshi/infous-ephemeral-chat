Info US--Ephemeral chat and Notes
A small web app that uses 2-step gated entry, vanishing messages, IndexedDB media,
WebRTC Datachannels, and a firestore mailbox fallback to enable reliable, ephemeral
comunication between two users.

The goal of the project was to build a real, working, gated chat system with:
1. Secure entry flow
2. Ephemeral message behavior
3. Reliable peer-to-peer media transfer
4. Firestore-based fallback when WebRTC is unavailable

Features
1. Two-step gated access (passcode → user login)
2. Vanish model: messages disappear after both users have seen them (unless saved)
3. Saved messages panel
4. Large media sending with chunking via WebRTC DataChannel
5. Local media outbox using IndexedDB to survive refresh
6. Mailbox fallback with Firestore if peer connection is not available
7. Connection retry system
8. Clean UI with message status indicators

Tech Stack
1. HTML, CSS, JavaScript
2. WebRTC (RTCPeerConnection + DataChannel)
3. Firebase Firestore (signaling + mailbox)
4. IndexedDB (media persistence)
5. LocalStorage (ephemeral + saved messages)

Project Structure
root/
**index.html-#Entry passcode gate**
**id.html-#Second login gate**
**home.html-#Hub page**
**chat.html-#Ephemeral chat UI**
**chat.css-#Styles**
**webrtc.js-#Signaling, DataChannel, mailbox & chunk logic
**
config.example.json
