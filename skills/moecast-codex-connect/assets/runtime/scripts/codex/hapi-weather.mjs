import {fault} from './hapi-device-store.mjs';
export const weatherPromptVersion='moecast-weather-v2-explicit-tools';
export const weatherInstructions=`你是萌播天气小姐，回答本次天气问题。当前地点和工具结果由 App 提供，不包含电脑工作聊天。用用户的语言简短回答，适合口头播报。天气事实必须来自本次工具结果；缺少数据时先请求工具，失败时如实说明。observations=[] 只表示尚未查询，不表示工具不可用。以下四个工具当前均已接通，由 App 执行；没有 Codex 函数工具列表不影响调用。用户问当前地点的温度时，先返回 {"text":"","tool":{"name":"weather_current","locationId":"current","date":null,"city":null}}，收到天气结果后再回答。不要在尚未查询时说数据不可用。不要凭记忆编天气，不派活、不访问工作聊天、不记录历史。工具采用 JSON 协议：tool 是下一次只读查询，App 执行后提供结果；不是 Codex 的函数工具。location_resolve 用 name，weather_current/weather_daily/weather_hourly 用 locationId，默认地点 ID=current。先解析用户指定的其他城市，使用实际返回的 ID；不确定城市时问清楚。daily 覆盖7天，hourly覆盖24小时，不提供历史或官方预警。不能执行画面、手机设置或其他操作时说明。一次只请求一个工具；最终回答 tool=null。不要在文字中声称已执行未收到回执的操作。`;
const nullable={type:['string','null']};
export const weatherSchema={type:'object',additionalProperties:false,required:['text','tool'],properties:{text:{type:'string'},tool:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['name','locationId','date','city'],properties:{name:{type:'string',enum:['location_resolve','weather_current','weather_daily','weather_hourly']},locationId:nullable,date:nullable,city:nullable}}]}}};
export async function weatherTurn({store,assistant},id,input,signal){
  store.require(id);
  if(!input||typeof input.text!=='string'||!input.text.trim()||input.text.length>2000||!input.location||typeof input.location.name!=='string'||!Number.isFinite(input.location.latitude)||Math.abs(input.location.latitude)>90||!Number.isFinite(input.location.longitude)||Math.abs(input.location.longitude)>180||!Array.isArray(input.observations)||input.observations.length>8||JSON.stringify(input).length>100000)throw fault('INVALID_WEATHER_REQUEST');
  const model=assistant?.preferences(id)?.model;
  const answer=await assistant.model.run({...input,capabilities:{tools:['location_resolve','weather_current','weather_daily','weather_hourly'],transport:'App executes the tool field and returns observations'}},model,{instructions:weatherInstructions,schema:weatherSchema,promptVersion:weatherPromptVersion,signal});
  signal?.throwIfAborted();store.require(id);
  let result;try{result=JSON.parse(answer.raw);}catch{throw fault('WEATHER_OUTPUT_INVALID',502);}
  if(typeof result?.text!=='string'||result.text.length>4000||!Object.hasOwn(result,'tool'))throw fault('WEATHER_OUTPUT_INVALID',502);
  if(result.tool!==null){const t=result.tool;if(!t||!['location_resolve','weather_current','weather_daily','weather_hourly'].includes(t.name)||t.name==='location_resolve'&&(typeof t.city!=='string'||!t.city.trim()||t.city.length>120)||t.name!=='location_resolve'&&(typeof t.locationId!=='string'||t.locationId.length>256)||t.date!=null&&(typeof t.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(t.date)))throw fault('WEATHER_OUTPUT_INVALID',502);}
  return {...result,model,promptVersion:weatherPromptVersion};
}
