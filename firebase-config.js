// ─── Firebase project configuration ───────────────────────────────────────────
//
// 1. Go to https://console.firebase.google.com
// 2. Create a project (or open an existing one)
// 3. Project Settings → Your apps → Add app → Web (</>)
// 4. Copy the firebaseConfig object and paste the values below
//
// It is safe to commit this file — Firebase config is not secret.
// Security is enforced by Firestore Rules, not by hiding the config.

export const firebaseConfig = {
  apiKey:            'YOUR_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId:             'YOUR_APP_ID',
};
