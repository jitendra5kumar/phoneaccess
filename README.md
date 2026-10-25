 npx react-native start --reset-cache

 Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json

npx react-native start --reset-cache   
npm run android
cd android
./gradlew clean
./gradlew assembleRelease
