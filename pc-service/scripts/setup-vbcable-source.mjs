import 'dotenv/config';
import OBSWebSocket from 'obs-websocket-js';

const INPUT_NAME = 'Micro Téléphone (Couch Stream App)';
const VBCABLE_DEVICE_ID = '{0.0.1.00000000}.{2ffd9b81-3fda-4c46-a593-c51c746ee8db}';

const obs = new OBSWebSocket();
await obs.connect(process.env.OBS_WEBSOCKET_URL, process.env.OBS_WEBSOCKET_PASSWORD);

const { inputs } = await obs.call('GetInputList');
const alreadyExists = inputs.some((i) => i.inputName === INPUT_NAME);

const { scenes } = await obs.call('GetSceneList');
const sceneNames = scenes.map((s) => s.sceneName);

if (alreadyExists) {
  console.log(`Input "${INPUT_NAME}" already exists - skipping creation, syncing settings only.`);
  await obs.call('SetInputSettings', {
    inputName: INPUT_NAME,
    inputSettings: { device_id: VBCABLE_DEVICE_ID },
  });
} else {
  // Create it in the first scene, then add scene items to the rest.
  const firstScene = sceneNames[0];
  await obs.call('CreateInput', {
    sceneName: firstScene,
    inputName: INPUT_NAME,
    inputKind: 'wasapi_input_capture',
    inputSettings: { device_id: VBCABLE_DEVICE_ID },
    sceneItemEnabled: true,
  });
  console.log(`Created input "${INPUT_NAME}" in scene "${firstScene}".`);

  for (const sceneName of sceneNames) {
    if (sceneName === firstScene) continue;
    await obs.call('CreateSceneItem', {
      sceneName,
      sourceName: INPUT_NAME,
      sceneItemEnabled: true,
    });
    console.log(`Added to scene "${sceneName}".`);
  }
}

const { inputVolumeMul } = await obs.call('GetInputVolume', { inputName: INPUT_NAME });
console.log(`Current volume (mult): ${inputVolumeMul}`);

await obs.disconnect();
console.log('Done.');
