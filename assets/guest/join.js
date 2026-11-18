// Invitation token is never placed in a URL, log, cookie, or local storage.
// Public single-use acceptance endpoint; the API independently verifies token and expiry.
const $=id=>document.getElementById(id);
const form=$('joinForm');
function status(message,error=false){
  const node=$('status');node.className=error?'error':'';node.textContent=message;
}
form.addEventListener('submit',async event=>{
  event.preventDefault();
  const token=$('token').value.trim().toLowerCase();
  const password=$('password').value;
  if(!/^[a-f0-9]{64}$/.test(token))return status('Недопустимый токен приглашения.',true);
  if(password.length<12||password.length>200)return status('Пароль должен состоять из 12–200 символов.',true);
  if(password!==$('repeat').value)return status('Пароли не совпадают.',true);
  $('submit').disabled=true;
  status('Проверяем приглашение…');
  try{
    const response=await fetch('/api/industry/v1/staff/invitations/accept',{
      method:'POST',credentials:'omit',cache:'no-store',
      headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({token,password})
    });
    const type=response.headers.get('content-type')||'';
    if(!type.includes('application/json'))throw Error('API не отвечает. Обратитесь к администратору компании.');
    const data=await response.json();
    if(!response.ok)throw Error(data?.error||'Приглашение недействительно или истекло.');
    if(data.accepted!==true)throw Error('API не подтвердил принятие приглашения.');
    $('token').value='';$('password').value='';$('repeat').value='';
    form.hidden=true;$('success').hidden=false;
    status('Приглашение успешно принято. Войдите под своей учётной записью.');
  }catch(error){
    $('password').value='';$('repeat').value='';
    status(error.message||'Нет соединения с сервером. Приглашение не принято.',true);
  }finally{$('submit').disabled=false;}
});
