import 'dotenv/config';
import OBSWebSocket from 'obs-websocket-js';

const obs = new OBSWebSocket();
await obs.connect(process.env.OBS_WEBSOCKET_URL, process.env.OBS_WEBSOCKET_PASSWORD);

const { propertyItems } = await obs.call('GetInputPropertiesListPropertyItems', {
  inputName: 'Mic/Aux',
  propertyName: 'device_id',
});

console.log('Available wasapi_input_capture devices:');
for (const item of propertyItems) {
  console.log(`  itemName=${JSON.stringify(item.itemName)}  itemValue=${JSON.stringify(item.itemValue)}`);
}

await obs.disconnect();
