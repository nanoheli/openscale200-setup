// Prints what the site's MSP client reads from the FC (SITL on TCP 5761).
import { MspClient } from "../site/js/msp.js";
import { connectTcp } from "./tcp-transport.mjs";

const transport = await connectTcp();
const msp = new MspClient(transport);
console.log(JSON.stringify(await msp.identify()));
msp.dispose();
await transport.close();
