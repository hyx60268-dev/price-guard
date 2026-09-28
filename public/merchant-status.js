export function merchantMonitorStatus(record,cloud=[],result={}){
 const saved=cloud.find(m=>m.key===record.key);
 if(!saved?.enabled||Date.parse(saved.updatedAt)<Date.parse(record.updatedAt))return '本机已保存 · 待提交云端';
 const source=(result?.merchants||[]).find(m=>m.key===record.key);
 if(!source||!result.checkedAt||Date.parse(result.checkedAt)<Date.parse(saved.updatedAt))return '配置已同步 · 等待首次监控结果';
 const stamp=new Date(result.checkedAt).toLocaleString('zh-CN');
 if(source.status==='error')return `监控读取失败 · ${stamp} · 云端将重试`;
 if(source.status==='deferred')return `本轮未轮到 · ${stamp} · 下轮继续`;
 const counts=`已读取 ${source.cards||0} 件 · 待查详情 ${source.pendingDetails||0} 件`;
 return `${source.status==='ok'?'本轮监控完成':'已取得部分结果'} · ${counts} · ${stamp}`;
}
