export const actionLabels={automatic_reset:'用量重置',banked_reset:'重置卡'};
export const stageLabels={promised:'发放预告',in_progress:'进行中',claimed_complete:'公告称已完成',cancelled:'已取消'};
export const time=(v?:string)=>v?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):'暂无记录';
export const fullTime=(v?:string)=>v?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):'暂无记录';
