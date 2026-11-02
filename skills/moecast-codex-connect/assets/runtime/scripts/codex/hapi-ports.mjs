// Optional isolated test installations; all services still bind loopback only.
const port=(name,fallback)=>{const raw=process.env[name];if(raw===undefined)return fallback;if(!/^\d+$/.test(raw)||Number(raw)<1024||Number(raw)>65535)throw Error('INVALID_CONNECTION_PORT');return Number(raw);};
export const hubPort=port('MOECAST_HAPI_PORT',3316),gatewayPort=port('MOECAST_GATEWAY_PORT',3317);
if(hubPort===gatewayPort)throw Error('CONNECTION_PORT_CONFLICT');
export const hubUrl=`http://127.0.0.1:${hubPort}`,gatewayUrl=`http://127.0.0.1:${gatewayPort}`;
