// Guest Intelligence experiment model: no personal data, no network, no false attribution.
export function count(value, name, {positive=false}={}) {
  const n = Number(value);
  if (String(value).trim()==='' || !Number.isSafeInteger(n) || n < (positive ? 1 : 0)) throw new RangeError(name + ': укажите целое ' + (positive ? 'положительное' : 'неотрицательное') + ' число');
  return n;
}
export function money(value, name) {
  if (String(value).trim()==='' || !Number.isFinite(Number(value)) || Number(value)<0 || Number(value)>1e9) throw new RangeError(name + ': укажите сумму от 0 до 1 млрд ₽');
  return Math.round(Number(value)*100)/100;
}
export function cohort(input) {
  const control=count(input.control,'Группа сравнения',{positive:true});
  const controlReturn=count(input.controlReturn,'Возвраты группы сравнения');
  const offer=count(input.offer,'Группа с предложением',{positive:true});
  const offerReturn=count(input.offerReturn,'Возвраты с предложением');
  if(controlReturn>control || offerReturn>offer) throw new RangeError('Возвраты не могут превышать размер группы');
  const a=controlReturn/control,b=offerReturn/offer,difference=b-a;
  // Wilson interval on difference via Newcombe independent-proportions method.
  const wilson=(x,n)=>{const p=x/n,z=1.959963984540054,z2=z*z,denom=1+z2/n;const mid=(p+z2/(2*n))/denom;const half=z*Math.sqrt(p*(1-p)/n+z2/(4*n*n))/denom;return [Math.max(0,mid-half),Math.min(1,mid+half)];};
  const [al,ah]=wilson(controlReturn,control),[bl,bh]=wilson(offerReturn,offer);
  const lower=difference-Math.sqrt((b-bl)**2+(ah-a)**2);
  const upper=difference+Math.sqrt((bh-b)**2+(a-al)**2);
  return {controlRate:a,offerRate:b,difference,range:[lower,upper],offerSize:offer,controlSize:control,offerReturn,controlReturn,uncertain:lower<=0&&upper>=0};
}
export function economics(input, result) {
  const margin=money(input.margin,'Маржа дополнительного визита');
  const discount=money(input.discount,'Стоимость предложения на гостя');
  const fixed=money(input.fixed,'Фиксированные расходы');
  const fee=money(input.fee,'Стоимость услуги');
  // This is a scenario, NOT a causal uplift or realized revenue. 
  const incrementalVisits=result.difference*result.offerSize;
  const net=incrementalVisits*margin - result.offerSize*discount - fixed - fee;
  const breakEven=margin>0?Math.ceil((result.offerSize*discount+fixed+fee)/margin):null;
  return {incrementalVisits,net,breakEven,assumption:'Разность долей не доказывает причинный эффект. Скидка учитывается для всех гостей группы с предложением.'};
}
export function csv(rows) {
  const cell=value=>'"'+String(value??'').replace(/^[=+\-@\t\r]/, match => String.fromCharCode(39)+match).replaceAll('"','""')+'"';
  return '\uFEFF'+rows.map(row=>row.map(cell).join(';')).join('\r\n')+'\r\n';
}
