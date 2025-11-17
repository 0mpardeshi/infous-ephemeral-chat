/*
  webrtc.js: Core WebRTC signaling, DataChannel, and media chunking logic.

  This file handles:
  1. Initializing Firebase and Firestore for signaling.
  2. Managing WebRTC peer connection (RTCPeerConnection).
  3. Handling ICE candidates and SDP offers/answers.
  4. Creating and managing the DataChannel for real-time communication.
  5. Implementing chunked media transfer over the DataChannel.
  6. Providing a mailbox fallback for text messages and media metadata when DataChannel is offline.
  7. Notifying chat.html about incoming messages and media transfer progress/completion.
*/

// --- Firebase Initialization ---
const firebaseConfig = {
  // Replace with your actual Firebase project configuration
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase if not already initialized
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

// --- Global Variables ---
let peerConnection;
let dataChannel;
const offerOptions = {
  offerToReceiveAudio: 1,
  offerToReceiveVideo: 1
};

// User-specific IDs from sessionStorage (set during login)
const userId = sessionStorage.getItem('userId');
const partnerId = sessionStorage.getItem('partnerId');

if (!userId || !partnerId) {
  console.error("User ID or Partner ID not found in sessionStorage. Redirection likely to occur.");
  // Potentially redirect to login page if this happens unexpectedly in chat.html context
  // location.href = 'index.html';
}

// Firestore collection references
const callDoc = db.collection('calls').doc(userId);
const offerCandidates = callDoc.collection('offerCandidates');
const answerCandidates = callDoc.collection('answerCandidates');
const mailboxRef = db.collection('mailboxes').doc(userId); // My own mailbox
const partnerMailboxRef = db.collection('mailboxes').doc(partnerId); // Partner's mailbox

// --- WebRTC Setup ---
async function createPeerConnection() {
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // You can add more STUN/TURN servers here for better NAT traversal
    ]
  };
  peerConnection = new RTCPeerConnection(configuration);

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      console.debug("ICE candidate generated (sanitized)."); // Sanitized log
      offerCandidates.add(event.candidate.toJSON());
    }
  };

  peerConnection.ondatachannel = event => {
    console.debug('Received DataChannel.'); // Sanitized log
    dataChannel = event.channel;
    setupDataChannelListeners(dataChannel);
  };

  peerConnection.onconnectionstatechange = () => {
    console.debug('Peer connection state changed:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
      console.warn("Peer disconnected or failed. DataChannel likely closed.");
      dataChannel = null; // Clear dataChannel reference
    } else if (peerConnection.connectionState === 'connected') {
      console.debug("Peer connection established!");
      // On reconnection, attempt to resend any queued media
      // This is now handled by the startResendLoop in chat.html which calls window.resendPersistedMedia
    }
    // Update UI status if available (e.g., statusText in chat.html)
    if (document.getElementById('statusText')) {
        document.getElementById('statusText').textContent = `Connection: ${peerConnection.connectionState} 🔐`;
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.debug('ICE connection state changed:', peerConnection.iceConnectionState);
  };
}

// --- DataChannel Setup ---
function setupDataChannelListeners(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => {
    console.debug('DataChannel is open!');
    // If we have any pending media in IndexedDB, attempt to resend them now
    // This is now handled by the startResendLoop in chat.html which calls window.resendPersistedMedia
  };
  dataChannel.onclose = () => {
    console.debug('DataChannel is closed.');
    dataChannel = null;
  };
  dataChannel.onerror = (error) => {
    console.error('DataChannel error:', error);
  };
  dataChannel.onmessage = handleDataChannelMessage;
}

// --- Signaling (Firebase Firestore) ---

// Listener for partner's answer candidates
callDoc.collection('answerCandidates').onSnapshot(snapshot => {
  snapshot.docChanges().forEach(async change => {
    if (change.type === 'added') {
      const candidate = new RTCIceCandidate(change.doc.data());
      try {
        await peerConnection.addIceCandidate(candidate);
        console.debug("Added remote ICE candidate (sanitized)."); // Sanitized log
      } catch (e) {
        console.error("Error adding remote ICE candidate:", e);
      }
    }
  });
});

// Listener for partner's offer (if I am the answerer)
db.collection('calls').doc(partnerId).onSnapshot(async snapshot => {
  const data = snapshot.data();
  if (data && data.offer && !peerConnection) { // Only process if not already connected
    console.debug('Received offer from partner (sanitized).'); // Sanitized log
    await createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

    // Create answer
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await callDoc.set({ answer: answer.toJSON() }); // Send my answer to my call doc
    console.debug('Answer sent (sanitized).'); // Sanitized log

    // Listen for partner's ICE candidates (offerCandidates of partner)
    db.collection('calls').doc(partnerId).collection('offerCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          try {
            await peerConnection.addIceCandidate(candidate);
            console.debug("Added remote ICE candidate from offerer (sanitized)."); // Sanitized log
          } catch (e) {
            console.error("Error adding remote ICE candidate from offerer:", e);
          }
        }
      });
    });

    // Create DataChannel if it doesn't exist (only one side creates it initially)
    if (!dataChannel) {
        dataChannel = peerConnection.createDataChannel("chat");
        setupDataChannelListeners(dataChannel);
    }
  } else if (data && data.answer && peerConnection && peerConnection.localDescription) {
    // If I am the offerer, and receive an answer
    console.debug('Received answer from partner (sanitized).'); // Sanitized log
    if (!peerConnection.currentRemoteDescription) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  }
});


// --- Initiate Call (Offer) ---
async function makeCall() {
  await createPeerConnection();

  // Create DataChannel (only one side should create it, the offerer usually)
  dataChannel = peerConnection.createDataChannel("chat");
  setupDataChannelListeners(dataChannel);

  const offer = await peerConnection.createOffer(offerOptions);
  await peerConnection.setLocalDescription(offer);
  console.debug('Created local offer (sanitized).'); // Sanitized log

  await callDoc.set({ offer: offer.toJSON() });
}

// Immediately attempt to make a call on page load if user is 'boy' (arbitrary initiator)
// or wait for a UI action. For simplicity, we'll try to initiate connection on load.
// This might need refinement for actual "call" initiation vs. persistent chat connection.
window.addEventListener('load', async () => {
    // Assume 'boy' role initiates the call or makes the offer
    // In a real app, this would be more dynamic (e.g., user clicks 'Start Chat')
    if (sessionStorage.getItem('userRole') === 'boy') {
        console.debug("Attempting to make WebRTC call...");
        await makeCall();
    }
});


// --- Chunked Media Transfer Logic ---
const CHUNK_SIZE = 65536; // 64KB for DataChannel chunks
const receivingMedia = new Map(); // Store incoming chunks: {mediaId: {metadata, chunks[], receivedSize}}
const sendingProgress = new Map(); // Store sending progress: {mediaId: {sentBytes, totalBytes, callback}}

/**
 * Sends a media blob as chunks over the DataChannel.
 * @param {Blob} blob The media file to send.
 * @param {string} id Unique ID for this media transfer.
 * @param {string} type MIME type or custom type (e.g., 'image', 'video', 'file').
 * @param {string} filename Original filename.
 * @param {number} time Timestamp of the message.
 * @param {function} progressCallback Callback to update UI with progress (0-100).
 */
async function sendMediaChunksInternal(blob, id, type, filename, time, progressCallback) {
  // This is the internal function used by window.sendMediaChunks
  // It handles the actual DataChannel sending for chunked media.

  const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
  let offset = 0;
  let chunkNum = 0;

  sendingProgress.set(id, {
      sentBytes: 0,
      totalBytes: blob.size,
      progressCallback: progressCallback,
      metadataSent: false
  });

  // Ensure metadata is sent first as a JSON string
  if (!sendingProgress.get(id).metadataSent) {
      const metadataPayload = {
          type: 'media-metadata',
          id: id,
          mediaType: type,
          filename: filename,
          size: blob.size,
          totalChunks: totalChunks,
          time: time
      };
      dataChannel.send(JSON.stringify(metadataPayload));
      sendingProgress.get(id).metadataSent = true;
      console.debug('Media metadata sent (sanitized).'); // Sanitized log
  }

  const sendChunk = () => {
      if (offset < blob.size) {
          const chunk = blob.slice(offset, offset + CHUNK_SIZE);

          // Create a small JSON header for the chunk
          const chunkHeader = JSON.stringify({
              id: id,
              seq: chunkNum,
              total: totalChunks,
              type: 'media-chunk-header' // Indicate it's a header
          });
          const headerBuffer = new TextEncoder().encode(chunkHeader);
          const headerLengthBuffer = new ArrayBuffer(4);
          new DataView(headerLengthBuffer).setUint32(0, headerBuffer.byteLength);

          // Combine header length, header, and chunk payload into a single ArrayBuffer
          const combinedBuffer = new Uint8Array(4 + headerBuffer.byteLength + chunk.size);
          combinedBuffer.set(new Uint8Array(headerLengthBuffer), 0);
          combinedBuffer.set(headerBuffer, 4);
          combinedBuffer.set(new Uint8Array(chunk), 4 + headerBuffer.byteLength);

          dataChannel.send(combinedBuffer.buffer); // Send the combined ArrayBuffer

          offset += chunk.size;
          chunkNum++;

          const currentProgress = Math.min(100, Math.round((offset / blob.size) * 100));
          const progressEntry = sendingProgress.get(id);
          if (progressEntry) {
              progressEntry.sentBytes = offset;
              progressEntry.progressCallback(currentProgress);
          }

          // Schedule next chunk with a small delay
          setTimeout(sendChunk, 20); // Adjust delay as needed
      } else {
          console.debug(`Finished sending all chunks for media ${id}`); // Sanitized log
          sendingProgress.delete(id);
          // Once all chunks are sent, delete the media from IndexedDB
          // This should happen once the receiver acknowledges 'seen'
          // For now, we'll delete immediately upon successful send.
          // A more robust system would wait for ACK.
          if (typeof window.deleteMediaFromDB === 'function') {
              window.deleteMediaFromDB(id).catch(()=>{});
          }
      }
  };

  sendChunk(); // Start sending chunks
}

/**
 * Handles incoming DataChannel messages.
 * Differentiates between string (JSON) messages and binary (ArrayBuffer) messages.
 * @param {MessageEvent} event
 */
async function handleDataChannelMessage(event) {
  if (typeof event.data === 'string') {
    // Handle JSON messages (text chat, metadata, control messages)
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      console.debug('Received non-JSON DataChannel string message.'); // Sanitized log
      return;
    }

    if (message.type === 'chat' || message.type === 'unsend' || message.type === 'edit' || message.type === 'seen') {
        if (window.handleIncoming) window.handleIncoming(message);
    } else if (message.type === 'media-metadata') {
        console.debug("Received media metadata (sanitized)."); // Sanitized log
        if (window.handleIncoming) {
            window.handleIncoming({
                type: 'chat', // Use chat type for general UI handling
                payload: {
                    id: message.id,
                    type: 'media-metadata', // Internal type to differentiate
                    mediaType: message.mediaType,
                    filename: message.filename,
                    size: message.size,
                    time: message.time
                }
            });
        }

        // Initialize receiving state
        receivingMedia.set(message.id, {
            metadata: message,
            chunks: new Array(message.totalChunks),
            receivedCount: 0,
            receivedSize: 0,
            expectedSize: message.size,
            time: message.time // Store time for final message rendering
        });
    }
  } else if (event.data instanceof ArrayBuffer) {
    // Handle binary ArrayBuffer messages (media chunks)
    const buffer = event.data;
    try {
      // Read length of metadata from the first 4 bytes
      const metadataLength = new DataView(buffer).getUint32(0);
      const metadataBytes = buffer.slice(4, 4 + metadataLength);
      const chunkMetadata = JSON.parse(new TextDecoder().decode(metadataBytes));
      const chunkPayload = buffer.slice(4 + metadataLength);

      if (chunkMetadata.type !== 'media-chunk-header') {
          console.debug('Received unexpected binary message without media-chunk-header type.');
          return;
      }
      // console.debug('Received media chunk header (sanitized).'); // Sanitized log (too verbose if every chunk)

      const mediaId = chunkMetadata.id;
      const mediaState = receivingMedia.get(mediaId);

      if (!mediaState) {
          console.debug(`Received chunk for unknown media ID or metadata not yet received.`); // Sanitized log
          return;
      }

      mediaState.chunks[chunkMetadata.seq] = chunkPayload;
      mediaState.receivedCount++;
      mediaState.receivedSize += chunkPayload.byteLength;

      // Update progress in UI
      const progress = Math.round((mediaState.receivedSize / mediaState.expectedSize) * 100);
      if (window.mediaProgressCallback) {
          window.mediaProgressCallback(mediaId, progress);
      }

      if (mediaState.receivedCount === mediaState.metadata.totalChunks) {
          console.debug(`All chunks received for media ID: ${mediaId}`); // Sanitized log
          const fullBlob = new Blob(mediaState.chunks, { type: mediaState.metadata.mediaType });

          // Notify chat.html that media is ready
          if (window.mediaReceivedCallback) {
              window.mediaReceivedCallback(mediaId, fullBlob, mediaState.metadata.mediaType, mediaState.metadata.filename, mediaState.time);
          }

          // Clean up
          receivingMedia.delete(mediaId);
      }
    } catch (e) {
      console.error('Error processing binary DataChannel message (chunk):', e);
    }
  }
}


// --- Expose functions to chat.html ---
// This allows chat.html to call these functions without global conflicts.

// Function to send regular text messages (without chunking)
window.sendOverDataChannel = function(message) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  } else {
    // DataChannel not open, queue message to Firestore mailbox
    console.debug('DataChannel not open. Queuing message to Firestore mailbox.');
    // Only queue specific fields needed for the receiver to display a placeholder/text
    const payloadToMailbox = {
        id: message.payload.id,
        from: userId, // Sender ID
        type: message.payload.type, // 'text' or 'media-metadata'
        text: message.payload.text, // Message content or filename
        time: message.payload.time,
        // For replies, include relevant reply data
        replyToId: message.payload.replyToId,
        replyToText: message.payload.replyToText,
        replyToFrom: message.payload.replyToFrom,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    };
    // If it's media metadata, also include size and mediaType
    if (message.payload.type === 'media-metadata') {
        payloadToMailbox.mediaType = message.payload.mediaType;
        payloadToMailbox.size = message.payload.size;
        payloadToMailbox.filename = message.payload.filename;
        payloadToMailbox.needsDelivery = true; // Flag for media that needs WebRTC delivery
    }
    queueToMailbox(payloadToMailbox);
  }
};

// Function for chat.html to trigger chunked media sending
window.sendMediaChunks = async function(blob, id, type, filename, time, progressCallback) {
    // If the file is small, send it as a single (but still structured) message
    if (blob.size < CHUNK_SIZE) { // If it's less than one chunk
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            const payload = {
                id: id,
                from: 'me',
                type: type, // 'image', 'video', 'audio', 'file'
                text: filename,
                url: dataUrl, // Small files can still use dataURL for simplicity
                time: time,
                saved: false,
                seenBy: {me:true, other:false}
            };
            // Send as a regular chat message via DataChannel (or mailbox if offline)
            if (window.sendOverDataChannel) {
                window.sendOverDataChannel({type:'chat', payload: payload});
            }
            if (progressCallback) progressCallback(100); // Mark as 100% sent
            // Delete from IndexedDB here since it's sent as a single message and not chunked
            if (typeof window.deleteMediaFromDB === 'function') {
                window.deleteMediaFromDB(id).catch(()=>{});
            }
        };
        reader.onerror = (e) => console.error("FileReader error for small media:", e);
        reader.readAsDataURL(blob);
        return;
    }

    // For large files, use chunking
    if (!dataChannel || dataChannel.readyState !== 'open') {
        console.debug('DataChannel not open for chunked media. Queuing metadata to mailbox.');
        // Only send metadata to mailbox for large files. Actual content will await WebRTC.
        window.sendOverDataChannel({ // Use sendOverDataChannel to handle mailbox fallback for metadata
            type: 'chat',
            payload: {
                id: id,
                from: 'me',
                type: 'media-metadata', // Special internal type to signify metadata only
                mediaType: type,
                filename: filename,
                size: blob.size,
                time: time,
                needsDelivery: true, // Flag for media that needs WebRTC delivery
                seenBy: {me:true, other:false} // Set seenBy for UI
            }
        });
        return; // Exit, actual sending will be retried by resend loop
    }

    // If DataChannel is open, proceed with chunked sending
    sendMediaChunksInternal(blob, id, type, filename, time, progressCallback);
};


// --- Mailbox Fallback (Firestore) ---
async function queueToMailbox(messagePayload) {
  try {
    // Use partnerMailboxRef to write to the partner's inbox
    await partnerMailboxRef.collection('inbox').add(messagePayload);
    console.debug('Message queued to mailbox for partner (sanitized).'); // Sanitized log
  } catch (e) {
    console.error('Error queuing to mailbox:', e);
  }
}

/**
 * Fetches pending messages from the user's Firestore mailbox.
 * Handles both text messages and media metadata.
 * This function belongs ONLY in webrtc.js.
 * @returns {Array} An array of delivered messages.
 */
window.fetchMailbox = async function() {
  const deliveredMessages = [];
  try {
    const inboxRef = mailboxRef.collection('inbox');
    // Fetch all documents ordered by timestamp
    const snapshot = await inboxRef.orderBy('timestamp').get();

    for (const doc of snapshot.docs) {
      const msg = doc.data();
      let normalizedMessage = null;
      let decryptionSuccess = true; // Assume success for now, as no actual decryption is implemented

      try {
        // Placeholder for decryption: In a real app, this would involve decrypting
        // the `msg.encryptedPayload` using keys only available in webrtc.js.
        // For this exercise, we treat the data directly as the message.

        if (msg.type === 'text') {
          normalizedMessage = {
            type: 'chat',
            payload: {
              id: msg.id || 'mb_' + doc.id, // Generate ID if not present
              from: 'other', // From the perspective of the receiver
              type: 'text',
              text: msg.text,
              time: msg.time || (msg.timestamp ? msg.timestamp.toDate().getTime() : Date.now()),
              saved: false,
              replyToId: msg.replyToId,
              replyToText: msg.replyToText,
              replyToFrom: msg.replyToFrom,
              seenBy: {me:false, other:true} // Mark as seen by other (sender) since it's in inbox
            }
          };
        } else if (msg.type === 'media-metadata' && msg.needsDelivery) {
            // This is media metadata queued for a large file transfer via WebRTC
            normalizedMessage = {
                type: 'chat', // Use chat type for general UI handling
                payload: {
                    id: msg.id,
                    from: 'other',
                    type: 'media-metadata', // Internal type for UI to create placeholder
                    mediaType: msg.mediaType, // e.g., 'image', 'video', 'audio', 'file'
                    filename: msg.filename,
                    size: msg.size,
                    time: msg.time || (msg.timestamp ? msg.timestamp.toDate().getTime() : Date.now()),
                    status: 'pending-download', // Indicates it's from mailbox and needs WebRTC transfer
                    seenBy: {me:false, other:true} // Seen by sender if in mailbox
                }
            };
        } else if (['image', 'video', 'audio', 'file'].includes(msg.type) && msg.url) {
            // This case handles small media files that were sent as dataURLs
            normalizedMessage = {
                type: 'chat',
                payload: {
                    id: msg.id || 'mb_' + doc.id,
                    from: 'other',
                    type: msg.type,
                    text: msg.text || msg.filename,
                    url: msg.url, // Contains the dataURL for small media
                    time: msg.time || (msg.timestamp ? msg.timestamp.toDate().getTime() : Date.now()),
                    saved: false,
                    seenBy: {me:false, other:true},
                    status: 'received' // Already has the content
                }
            };
        } else {
            console.debug('Mailbox: Unrecognized message type or format.'); // Sanitized log
            decryptionSuccess = false; // Treat as a 'decryption failure' for unknown types
        }

      } catch (e) {
        console.error('Mailbox: Error processing message, likely decryption failure:', e); // Keep error, remove sensitive data
        decryptionSuccess = false;
      }

      if (decryptionSuccess && normalizedMessage) {
        deliveredMessages.push(normalizedMessage);
        if (window.handleIncoming) {
            // Pass to chat.html's handleIncoming for display
            window.handleIncoming(normalizedMessage);
        }
        // Delete message from inbox ONLY if successfully processed/decrypted
        await doc.ref.delete();
        console.debug('Mailbox: Deleted processed message from inbox.'); // Sanitized log
      } else {
        console.warn('Mailbox: Failed to process/decrypt message, leaving in inbox.'); // Sanitized log
      }
    }
  } catch (e) {
    console.error('Mailbox: Error fetching from mailbox:', e);
  }
  return deliveredMessages;
};

// Resend persisted media from IndexedDB (defined in chat.html but called here)
// This function needs to be exposed by chat.html to webrtc.js
window.resendPersistedMedia = async function() {
    try {
        if (typeof window.getAllMediaFromDB !== 'function') {
            console.debug('getAllMediaFromDB not available in chat.html for resending persisted media.');
            return;
        }
        const items = await window.getAllMediaFromDB(); // From chat.html's IndexedDB functions
        for (const it of items) {
            // Re-queue for sending via chunking (if DataChannel open) or mailbox (metadata)
            if (typeof window.sendMediaChunks === 'function') {
                window.sendMediaChunks(it.blob, it.id, it.type, it.name, it.time, (progress) => {
                    // Update progress in chat.html's UI
                    if (window.mediaProgressCallback) {
                        window.mediaProgressCallback(it.id, progress);
                    }
                });
            } else {
                console.debug('sendMediaChunks not available for resending persisted media.');
            }
        }
    } catch (e) {
        console.warn('resendPersistedMedia error in webrtc.js:', e);
    }
};

// This needs to be available globally for chat.html to interact with
// the WebRTC setup.
// Example: `window.sendOverDataChannel = sendOverDataChannel;`
// already done above.
