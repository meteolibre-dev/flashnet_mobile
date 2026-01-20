# Building your Android App for the Play Store

To build your Android app bundle (.aab) for the Google Play Store, run this command in your terminal:

```bash
npx eas-cli build --platform android
```

## After the build finishes:
1. Go to the URL provided in the terminal to download your `.aab` file.
2. Log in to the [Google Play Console](https://play.google.com/console).
3. Create a new app.
4. Upload the `.aab` file to the "Production" or "Internal Testing" track.

## Future Updates
For future updates (after the first one is live), you can use:
```bash
npx eas-cli build --platform android --auto-submit
```

## Local build
```bash
export ANDROID_HOME=/home/adrienbufort/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
npx eas-cli build --platform android --local --profile production
```
