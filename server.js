// ./server.js
import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import bodyParser from 'body-parser';
import cron from 'node-cron';
import { config } from "dotenv";
import { readFileSync } from 'fs';
import os from 'os';

config()

// Assigning values from environment variables to serviceAccount
const serviceAccount = {
    "type": process.env.GOOGLE_APPLICATION_CREDENTIALS_TYPE,
    "project_id": process.env.GOOGLE_APPLICATION_CREDENTIALS_PROJECT_ID,
    "private_key_id": process.env.GOOGLE_APPLICATION_CREDENTIALS_PRIVATE_KEY_ID,
    "private_key": process.env.GOOGLE_APPLICATION_CREDENTIALS_PRIVATE_KEY,
    "client_email": process.env.GOOGLE_APPLICATION_CREDENTIALS_CLIENT_EMAIL,
    "client_id": process.env.GOOGLE_APPLICATION_CREDENTIALS_CLIENT_ID,
    "auth_uri": process.env.GOOGLE_APPLICATION_CREDENTIALS_AUTH_URI,
    "token_uri": process.env.GOOGLE_APPLICATION_CREDENTIALS_TOKEN_URI,
    "auth_provider_x509_cert_url": process.env.GOOGLE_APPLICATION_CREDENTIALS_AUTH_PROVIDER_X509_CERT_URL,
    "client_x509_cert_url": process.env.GOOGLE_APPLICATION_CREDENTIALS_CLIENT_X509_CERT_URL,
    "universe_domain": process.env.GOOGLE_APPLICATION_CREDENTIALS_UNIVERSE_DOMAIN
};

// Function to determine the server's IP addresses
function getServerIpAddresses() {
  const networkInterfaces = os.networkInterfaces();
  const addresses = [];
  
  Object.keys(networkInterfaces).forEach(interfaceName => {
    const interfaces = networkInterfaces[interfaceName];
    interfaces.forEach(iface => {
      if (!iface.internal) {
        addresses.push({
          interface: interfaceName,
          family: `IPv${iface.family}`,
          address: iface.address
        });
      }
    });
  });
  
  return addresses;
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
}); 

const db = admin.firestore();
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Constants
const INITIAL_RADIUS_KM = 10;
const MAX_RADIUS_KM = 30;
const RADIUS_INCREMENT_KM = 10;
const NOTIFICATION_TIMEOUT_MINUTES = 5;
const BASE_URL = 'yourapp://ambulance';

// Function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371; // in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

function generateDeepLink(requestId, extraParams = {}) {
  let url = `${BASE_URL}/request/${requestId}`;
  if (Object.keys(extraParams).length > 0) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(extraParams)) {
      queryParams.append(key, value.toString());
    }
    url = `${url}?${queryParams.toString()}`;
  }
  console.log(`Generated deep link URL: ${url}`);
  return url;
}

async function handleNewAmbulanceRequest(requestId, emergencyData, locationData) {
  try {
    console.log(`Processing new ambulance request: ${requestId}`);
    
    let currentRadius = INITIAL_RADIUS_KM;
    let driversNotified = [];
    let requestAccepted = false;
    
    await db.collection('requestNotifications').doc(requestId).set({
      requestId,
      currentRadius,
      driversNotified,
      requestAccepted: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      nextNotificationTime: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + NOTIFICATION_TIMEOUT_MINUTES * 60000)
      )
    });
    
    await notifyDriversInRadius(requestId, locationData.latitude, locationData.longitude, currentRadius);
    
    console.log(`Initial notification sent for request: ${requestId} with ${currentRadius}km radius`);
  } catch (error) {
    console.error('Error handling new ambulance request:', error);
  }
}

async function notifyDriversInRadius(requestId, latitude, longitude, radiusKm) {
  try {
    console.log(`Finding drivers within ${radiusKm}km of location: ${latitude}, ${longitude}`);
    
    // Get the request to access the userId
    const requestDoc = await db.collection('ambulanceRequests').doc(requestId).get();
    if (!requestDoc.exists) {
      console.error(`Request ${requestId} not found`);
      return [];
    }
    const requestData = requestDoc.data();
    const requestUserId = requestData.userId;

    // Get all active drivers
    const driversSnapshot = await db.collection('drivers')
      .where('isDriverActive', '==', true)
      .get();
    
    if (driversSnapshot.empty) {
      console.log('No active drivers found');
      return [];
    }
    
    const notificationDoc = await db.collection('requestNotifications').doc(requestId).get();
    if (!notificationDoc.exists) {
      console.error(`Notification state for request ${requestId} not found`);
      return [];
    }
    
    const notificationState = notificationDoc.data();
    const previouslyNotifiedDrivers = notificationState.driversNotified || [];
    
    const eligibleDrivers = [];
    
    driversSnapshot.forEach(doc => {
      const driverData = doc.data();
      const driverId = doc.id;
      
      // Skip if already notified
      if (previouslyNotifiedDrivers.includes(driverId)) {
        return;
      }
      
      // Skip if this driver is the one who made the request
      if (driverId === requestUserId) {
        console.log(`Skipping driver ${driverId} as they are the requestor`);
        return;
      }
      
      if (!driverData.location) {
        return;
      }
      
      const driverLat = driverData.location.latitude;
      const driverLng = driverData.location.longitude;
      
      const distance = calculateDistance(
        latitude, 
        longitude, 
        driverLat, 
        driverLng
      );
      
      if (distance <= radiusKm) {
        eligibleDrivers.push({
          driverId,
          distance: Math.round(distance * 10) / 10,
          fcmToken: driverData.fcmToken
        });
      }
    });
    
    console.log(`Found ${eligibleDrivers.length} eligible drivers within ${radiusKm}km`);
    
    const notificationPromises = eligibleDrivers.map(async (driver) => {
      if (!driver.fcmToken) {
        console.log(`Driver ${driver.driverId} has no FCM token`);
        return null;
      }
      
      const message = {
        token: driver.fcmToken,
        notification: {
          title: 'New Ambulance Request',
          body: `Emergency request ${driver.distance}km away. Tap to view details.`
        },
        data: {
          requestId: requestId,
          type: 'ambulance_request',
          distance: driver.distance.toString(),
          emergencyType: requestData.emergency?.detailedReason || 'Emergency',
          latitude: latitude.toString(),
          longitude: longitude.toString(),
          serverUrl: SERVER_URL
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'ambulance_requests',
            priority: 'high'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1
            }
          }
        }
      };
      
      try {
        await admin.messaging().send(message);
        console.log(`Notification sent to driver ${driver.driverId}`);
        return driver.driverId;
      } catch (error) {
        console.error(`Error sending notification to driver ${driver.driverId}:`, error);
        return null;
      }
    });
    
    const notifiedDriverIds = (await Promise.all(notificationPromises))
      .filter(id => id !== null);
    
    if (notifiedDriverIds.length > 0) {
      await db.collection('requestNotifications').doc(requestId).update({
        driversNotified: admin.firestore.FieldValue.arrayUnion(...notifiedDriverIds),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastNotificationRadius: radiusKm
      });
    } else {
      await db.collection('requestNotifications').doc(requestId).update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastNotificationRadius: radiusKm
      });
      console.log(`No drivers were successfully notified for request ${requestId}`);
    }
    
    return notifiedDriverIds;
  } catch (error) {
    console.error('Error notifying drivers:', error);
    return [];
  }
}

async function expandRadiusIfNeeded() {
  try {
    console.log('Checking for requests needing radius expansion...');
    const now = admin.firestore.Timestamp.now();
    
    const notificationsSnapshot = await db.collection('requestNotifications')
      .where('requestAccepted', '==', false)
      .where('nextNotificationTime', '<=', now)
      .get();
    
    if (notificationsSnapshot.empty) {
      console.log('No requests need radius expansion at this time');
      return;
    }
    
    console.log(`Found ${notificationsSnapshot.size} requests needing radius expansion`);
    
    const promises = notificationsSnapshot.docs.map(async (doc) => {
      const notificationData = doc.data();
      const requestId = notificationData.requestId;
      
      const requestDoc = await db.collection('ambulanceRequests').doc(requestId).get();
      if (!requestDoc.exists) {
        console.log(`Request ${requestId} no longer exists, removing notification state`);
        await doc.ref.delete();
        return;
      }
      
      const requestData = requestDoc.data();
      if (requestData.status !== 'pending') {
        console.log(`Request ${requestId} is no longer pending (status: ${requestData.status}), updating notification state`);
        await doc.ref.update({
          requestAccepted: requestData.status === 'accepted',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return;
      }
      
      let newRadius = notificationData.currentRadius + RADIUS_INCREMENT_KM;
      if (newRadius > MAX_RADIUS_KM) {
        console.log(`Request ${requestId} has reached maximum radius (${MAX_RADIUS_KM}km)`);
        return;
      }
      
      console.log(`Expanding radius for request ${requestId} from ${notificationData.currentRadius}km to ${newRadius}km`);
      
      await notifyDriversInRadius(
        requestId, 
        requestData.location.latitude, 
        requestData.location.longitude, 
        newRadius
      );
      
      await doc.ref.update({
        currentRadius: newRadius,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        nextNotificationTime: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + NOTIFICATION_TIMEOUT_MINUTES * 60000)
        )
      });
    });
    
    await Promise.all(promises);
    console.log('Radius expansion check completed');
  } catch (error) {
    console.error('Error expanding radius:', error);
  }
}

cron.schedule('*/5 * * * *', async () => {
  console.log('Running scheduled radius expansion check');
  await expandRadiusIfNeeded();
});

app.post('/api/notify-drivers', async (req, res) => {
  try {
    const { requestId } = req.body;
    
    if (!requestId) {
      return res.status(400).json({ error: 'Request ID is required' });
    }
    
    const requestDoc = await db.collection('ambulanceRequests').doc(requestId).get();
    if (!requestDoc.exists) {
      return res.status(404).json({ error: 'Ambulance request not found' });
    }
    
    const requestData = requestDoc.data();
    
    if (requestData.status !== 'pending') {
      return res.status(400).json({ 
        error: 'Request is not in pending state',
        status: requestData.status
      });
    }
    
    await handleNewAmbulanceRequest(
      requestId,
      requestData.emergency,
      requestData.location
    );
    
    return res.json({ success: true, message: 'Notification process started' });
  } catch (error) {
    console.error('Error in notify-drivers endpoint:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function setupFirestoreListeners() {
  db.collection('ambulanceRequests')
    .where('status', '==', 'pending')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const requestData = change.doc.data();
          const requestId = change.doc.id;
          
          handleNewAmbulanceRequest(
            requestId, 
            requestData.emergency, 
            requestData.location
          );
        }
      });
    }, error => {
      console.error('Error listening to ambulance requests:', error);
    });
    
  db.collection('ambulanceRequests')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'modified') {
          const requestData = change.doc.data();
          const requestId = change.doc.id;
          
          if (requestData.status === 'accepted') {
            try {
              const notificationDoc = await db.collection('requestNotifications').doc(requestId).get();
              if (notificationDoc.exists) {
                await notificationDoc.ref.update({
                  requestAccepted: true,
                  acceptedDriverId: requestData.assignedDriverId,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`Request ${requestId} was accepted by driver ${requestData.assignedDriverId}`);
              }
            } catch (error) {
              console.error(`Error updating notification state for request ${requestId}:`, error);
            }
          }
        }
      });
    }, error => {
      console.error('Error listening to ambulance request changes:', error);
    });
}

const PORT = process.env.PORT || 3000;
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const NODE_ENV = process.env.NODE_ENV || 'development';

const getServerUrl = () => {
  if (process.env.SERVER_URL) {
    return process.env.SERVER_URL;
  }
  
  const protocol = NODE_ENV === 'production' ? 'https' : 'http';
  
  if (NODE_ENV === 'production') {
    if (PORT === 80 || PORT === 443) {
      return `${protocol}://${SERVER_HOST}`;
    }
    return `${protocol}://${SERVER_HOST}:${PORT}`;
  }
  
  return `${protocol}://${SERVER_HOST}:${PORT}`;
};

const SERVER_URL = getServerUrl();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Server URL: ${SERVER_URL}`);
  console.log(`Access the API at: ${SERVER_URL}/api/notification-status/:requestId`);
  setupFirestoreListeners();
  console.log('Firestore listeners established');
});

app.get('/api/server-info', (req, res) => {
  const serverInfo = {
    url: SERVER_URL,
    environment: NODE_ENV,
    version: '1.0.0',
    endpoints: {
      notifyDrivers: `${SERVER_URL}/api/notify-drivers`,
      notificationStatus: `${SERVER_URL}/api/notification-status/:requestId`,
      expandRadius: `${SERVER_URL}/api/expand-radius/:requestId`
    }
  };
  
  return res.json(serverInfo);
});

app.get('/api/notification-status/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    
    const notificationDoc = await db.collection('requestNotifications').doc(requestId).get();
    if (!notificationDoc.exists) {
      return res.status(404).json({ error: 'Notification state not found' });
    }
    
    return res.json(notificationDoc.data());
  } catch (error) {
    console.error('Error getting notification status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/expand-radius/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    
    const notificationDoc = await db.collection('requestNotifications').doc(requestId).get();
    if (!notificationDoc.exists) {
      return res.status(404).json({ error: 'Notification state not found' });
    }
    
    const notificationData = notificationDoc.data();
    
    const requestDoc = await db.collection('ambulanceRequests').doc(requestId).get();
    if (!requestDoc.exists) {
      return res.status(404).json({ error: 'Ambulance request not found' });
    }
    
    const requestData = requestDoc.data();
    
    let newRadius = notificationData.currentRadius + RADIUS_INCREMENT_KM;
    if (newRadius > MAX_RADIUS_KM) {
      newRadius = MAX_RADIUS_KM;
    }
    
    await notifyDriversInRadius(
      requestId, 
      requestData.location.latitude, 
      requestData.location.longitude, 
      newRadius
    );
    
    await notificationDoc.ref.update({
      currentRadius: newRadius,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      nextNotificationTime: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + NOTIFICATION_TIMEOUT_MINUTES * 60000)
      )
    });
    
    return res.json({ 
      success: true, 
      message: `Radius expanded to ${newRadius}km`,
      newRadius
    });
  } catch (error) {
    console.error('Error expanding radius:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/config/deep-link', async (req, res) => {
  try {
    const { baseUrl } = req.body;
    
    if (!baseUrl) {
      return res.status(400).json({ error: 'Base URL is required' });
    }
    
    return res.json({ 
      success: true, 
      message: 'Deep link base URL configured',
      baseUrl
    });
  } catch (error) {
    console.error('Error configuring deep link base URL:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default app;
