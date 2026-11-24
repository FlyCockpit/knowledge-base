//! Bounded newline MCP. Four workers/results, one input frame; protocol errors
//! are redacted. Cancellation and reservation serialize on one mutex. The host
//! owns domain IO and must join it before returning from its blocking handler.
use crate::{ErrorCode, MCP_PROFILE, ToolName, error::tool_error, mcp::catalog::Advertised};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    task::JoinSet,
};
pub const MAX_IN_FLIGHT: usize = 4;
pub const FRAME_MAX_BYTES: usize = 1024 * 1024;
pub const RESULT_MAX_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone, Debug)]
pub struct CallControl {
    cancelled: Arc<AtomicBool>,
    work: Arc<AtomicBool>,
    reserved: Arc<Mutex<bool>>,
    until: Instant,
    token: crate::CancellationToken,
}
impl Default for CallControl {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            work: Arc::new(AtomicBool::new(false)),
            reserved: Arc::new(Mutex::new(false)),
            token: crate::CancellationToken::new(),
            until: Instant::now() + Duration::from_secs(120),
        }
    }
}
impl CallControl {
    pub fn cancel(&self) {
        let reserved = self.reserved.lock().expect("reservation mutex");
        self.cancelled.store(true, Ordering::Release);
        if !*reserved {
            self.work.store(true, Ordering::Release);
            self.token.cancel();
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub fn work_flag(&self) -> Arc<AtomicBool> {
        self.work.clone()
    }
    pub fn work_token(&self) -> crate::CancellationToken {
        self.token.clone()
    }
    pub fn until(&self) -> Instant {
        self.until
    }
    /// Called immediately before durable publication reservation, under the
    /// store/KB locks. After this boundary cancellation suppresses delivery only.
    pub fn reserve(&self) -> Result<(), ErrorCode> {
        let mut reserved = self.reserved.lock().expect("reservation mutex");
        if self.work.load(Ordering::Acquire) {
            return Err(ErrorCode::Cancelled);
        }
        if Instant::now() >= self.until {
            return Err(ErrorCode::DeadlineExceeded);
        }
        *reserved = true;
        Ok(())
    }
}
/// The stderr line written when a client asks for a protocol revision other
/// than [`MCP_PROFILE`]; `None` when the versions match. The requested value is
/// untrusted input, so it is escaped and truncated.
pub fn version_diagnostic(requested: &str) -> Option<String> {
    if requested == MCP_PROFILE {
        return None;
    }
    let shown: String = requested.chars().take(64).collect();
    Some(format!(
        "kb mcp: client requested MCP protocol version {shown:?}; kb mcp speaks {MCP_PROFILE} and answered with it (the client decides whether to continue)"
    ))
}
fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
/// The per-request 2026-07-28 envelope, checked like the MCP SDK's
/// HTTP and stdio entries: `Ok(true)` when the request names the protocol
/// version in `_meta` and the envelope is valid (it is then served without a
/// handshake, exactly as on HTTP), `Ok(false)` when it makes no claim (it then
/// needs an `initialize` or `server/discover` session), and the JSON-RPC error
/// frame when the claim is malformed (any reserved field, nested capability
/// shapes included: [`crate::envelope`]) or names a revision this server does
/// not speak. A present claim is never ignored, in a session or not.
fn request_envelope(id: &Value, params: &Value) -> Result<bool, Value> {
    if let Some(meta) = params.get("_meta")
        && let Err(issue) = crate::schema::validate_request_meta(meta)
    {
        return Err(json!({"jsonrpc":"2.0","id":id,"error":{
            "code":-32600,"message":"Invalid Request",
            "data":{"field":format!("/params/_meta{}", issue.pointer),"reason":"SCHEMA","keyword":issue.keyword}
        }}));
    }
    let Some(meta) = params.get("_meta").and_then(Value::as_object) else {
        return Ok(false);
    };
    let version = meta.get(crate::envelope::PROTOCOL_VERSION);
    let issue = version.and_then(|_| crate::envelope::first_issue(meta));
    if let Some(issue) = issue {
        return Err(json!({"jsonrpc":"2.0","id":id,"error":{
            "code":-32602,
            "message":format!("Invalid _meta envelope for protocol revision {MCP_PROFILE}: {}: {}", issue.key, issue.problem),
            "data":{"envelope":{"key":issue.key,"problem":issue.problem}}
        }}));
    }
    let Some(version) = version else {
        return Ok(false);
    };
    let requested = version.as_str().expect("checked string");
    if requested != MCP_PROFILE {
        let shown: String = requested.chars().take(64).collect();
        return Err(json!({"jsonrpc":"2.0","id":id,"error":{
            "code":-32022,
            "message":format!("Unsupported protocol version: {shown}"),
            "data":{"supported":[MCP_PROFILE],"requested":shown}
        }}));
    }
    Ok(true)
}
fn result(id: Value, mut value: Value) -> Value {
    value["resultType"] = json!("complete");
    json!({"jsonrpc":"2.0","id":id,"result":value})
}
fn valid_id(id: &Value) -> bool {
    match id {
        Value::String(s) => !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control),
        Value::Number(_) => crate::format::safe_integer(id).is_some(),
        _ => false,
    }
}
fn id_key(id: &Value) -> String {
    if let Some(n) = crate::format::safe_integer(id) {
        format!("n:{n}")
    } else {
        format!("s:{}", id.as_str().expect("validated string id"))
    }
}
struct Frames<R> {
    reader: BufReader<R>,
    bytes: Vec<u8>,
    /// Skipping the rest of an oversize frame up to its newline.
    discarding: bool,
}
/// One input line: a request, or a line over [`FRAME_MAX_BYTES`] that was
/// skipped whole (answered with an error; the session keeps running).
enum Frame {
    Bytes(Vec<u8>),
    Oversize,
}
impl<R: AsyncRead + Unpin> Frames<R> {
    async fn next(&mut self) -> io::Result<Option<Frame>> {
        loop {
            let chunk = self.reader.fill_buf().await?;
            if chunk.is_empty() {
                return if self.bytes.is_empty() && !self.discarding {
                    Ok(None)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unterminated stdio frame",
                    ))
                };
            }
            let end = chunk.iter().position(|b| *b == b'\n');
            let n = end.map_or(chunk.len(), |i| i + 1);
            if self.discarding {
                self.reader.consume(n);
                if end.is_some() {
                    self.discarding = false;
                    return Ok(Some(Frame::Oversize));
                }
                continue;
            }
            if self.bytes.len() + n > FRAME_MAX_BYTES + 1 {
                // Never buffer past the bound: drop what we have and skip to
                // the end of this line.
                self.bytes = Vec::new();
                self.reader.consume(n);
                if end.is_some() {
                    return Ok(Some(Frame::Oversize));
                }
                self.discarding = true;
                continue;
            }
            self.bytes.extend_from_slice(&chunk[..n]);
            self.reader.consume(n);
            if end.is_some() {
                self.bytes.pop();
                return Ok(Some(Frame::Bytes(std::mem::take(&mut self.bytes))));
            }
        }
    }
}
/// Cancellation-safe reads/writes retain offsets in the session. Backpressure
/// bounds outgoing bytes to nine capped responses and domain calls to four.
/// EOF cancels unreserved work; output loss cancels then joins every worker.
/// Advertises the full local catalog.
pub async fn serve<R, W, F>(reader: R, writer: W, handler: F) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: Fn(ToolName, Value, CallControl) -> Value + Send + Sync + 'static,
{
    let advertised = Advertised::local().map_err(|_| io::Error::other("catalog unavailable"))?;
    serve_until(reader, writer, advertised, handler, std::future::pending()).await
}
/// Host shutdown follows the same cancellation and drain path as EOF. Only
/// `advertised` tools are listed; a call reaches `handler` only when
/// `advertised` admits it (listed by a forwarder, or allowed by the local scope).
pub async fn serve_until<R, W, F, S>(
    reader: R,
    writer: W,
    advertised: Advertised,
    handler: F,
    shutdown: S,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: Fn(ToolName, Value, CallControl) -> Value + Send + Sync + 'static,
    S: std::future::Future<Output = ()>,
{
    serve_admitted(
        reader,
        writer,
        Admission::Open(Box::new(advertised)),
        move |name, _, input, control| handler(name, input, control),
        shutdown,
    )
    .await
}
/// [`serve_until`] for a multi-server list ([`Advertised::union`]): the
/// handler also gets the call's `server` label, already checked against the
/// servers listing the tool and removed from the arguments; `None` only for a
/// call of the federated tool ([`Advertised::federate`]) that names no server.
pub async fn serve_routed_until<R, W, F, S>(
    reader: R,
    writer: W,
    advertised: Advertised,
    handler: F,
    shutdown: S,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: Fn(ToolName, Option<&str>, Value, CallControl) -> Value + Send + Sync + 'static,
    S: std::future::Future<Output = ()>,
{
    if advertised.routes().is_none() {
        return Err(io::Error::other(
            "a routed session needs a multi-server list",
        ));
    }
    let federated = advertised.federated();
    serve_admitted(
        reader,
        writer,
        Admission::Open(Box::new(advertised)),
        move |name, route: Option<String>, input, control| match route {
            Some(label) => handler(name, Some(&label), input, control),
            None if federated == Some(name) => handler(name, None, input, control),
            None => tool_error(ErrorCode::Internal, json!({})),
        },
        shutdown,
    )
    .await
}
/// Serve a session that could not start (server parity: a startup probe such
/// as the Git version check failed). There is no catalog and no handler:
/// every request except `ping` — handshake, discovery, enveloped or not —
/// gets the same `-32603` error carrying `code` and the actionable `message`.
pub async fn serve_refused<R, W, S>(
    reader: R,
    writer: W,
    code: ErrorCode,
    message: String,
    shutdown: S,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    S: std::future::Future<Output = ()>,
{
    serve_admitted(
        reader,
        writer,
        Admission::Refused { code, message },
        // Never called: a refused session routes no request to a handler.
        |_, _, _, _| tool_error(ErrorCode::Internal, json!({})),
        shutdown,
    )
    .await
}
/// Whether this stdio session serves at all, decided once at startup and
/// applied to every request before method routing.
enum Admission {
    // Boxed: a session's list is large beside a refusal.
    Open(Box<Advertised>),
    Refused { code: ErrorCode, message: String },
}
async fn serve_admitted<R, W, F, S>(
    reader: R,
    mut writer: W,
    admission: Admission,
    handler: F,
    shutdown: S,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: Fn(ToolName, Option<String>, Value, CallControl) -> Value + Send + Sync + 'static,
    S: std::future::Future<Output = ()>,
{
    tokio::pin!(shutdown);
    let handler = Arc::new(handler);
    let mut frames = Frames {
        reader: BufReader::new(reader),
        bytes: Vec::new(),
        discarding: false,
    };
    let mut jobs = JoinSet::new();
    let mut active: HashMap<String, (Value, CallControl)> = HashMap::new();
    // Active keys that are live `tools/list` rebuilds (cancelled as JSON-RPC
    // errors, not tool results).
    let mut lists: HashSet<String> = HashSet::new();
    // Active keys of multi-server calls, with the server each one names.
    let mut routes: HashMap<String, String> = HashMap::new();
    let mut output: VecDeque<(Vec<u8>, usize, Option<String>)> = VecDeque::new();
    let mut state = 0u8;
    let mut eof = false;
    let mut failure = None;
    let mut drain_until = None;
    let mut last_write = tokio::time::Instant::now();
    let mut was_writing = false;
    loop {
        if eof && jobs.is_empty() && output.is_empty() {
            break;
        }
        let writing = !output.is_empty();
        if writing && !was_writing {
            last_write = tokio::time::Instant::now();
        }
        was_writing = writing;
        let can_read = !eof && output.len() < MAX_IN_FLIGHT + 1;
        tokio::select! {biased;
            _ = &mut shutdown, if !eof => {eof=true;drain_until=Some(Instant::now()+Duration::from_secs(5));if let Err(e)=cancel_session(&active,&lists,&routes,&mut output){failure=Some(e);output.clear();}}

            joined=jobs.join_next(),if !jobs.is_empty()=>{
                match joined {
                    Some(Ok((key,reply)))=>{if let Some((id,ctl))=active.get(&key){let frame=if ctl.is_cancelled(){cancelled(id.clone(),lists.contains(&key),routes.get(&key))}else{match reply{Ok(value)=>result(id.clone(),value),Err(frame)=>frame}};if failure.is_none(){queue_routed(&mut output,frame,routes.get(&key).map(String::as_str))?;output.back_mut().expect("queued result").2=Some(key);}}}
                    _=>{failure=Some(io::Error::other("stdio worker failed"));eof=true;output.clear();for(_,c)in active.values(){c.cancel();}}
                }
            }
            written=async{let(bytes,offset,_)=output.front().expect("outgoing frame");writer.write(&bytes[*offset..]).await},if writing=>{
                match written {Ok(n) if n>0=>{last_write=tokio::time::Instant::now();let(bytes,offset,_)=output.front_mut().expect("outgoing frame");*offset+=n;if *offset==bytes.len(){let (_,_,key)=output.pop_front().expect("complete frame");if let Some(key)=key{active.remove(&key);lists.remove(&key);routes.remove(&key);}}},_=>{failure=Some(io::Error::new(io::ErrorKind::BrokenPipe,"stdio output closed"));output.clear();eof=true;for(_,c)in active.values(){c.cancel();}}}
            }
            next=frames.next(),if can_read=>{
                let bytes=match next{Ok(Some(Frame::Bytes(b)))=>b,Ok(Some(Frame::Oversize))=>{queue(&mut output,rpc_error(Value::Null,-32600,"Invalid request: frame exceeds 1 MiB"))?;continue},Ok(None)=>{eof=true;drain_until=Some(Instant::now()+Duration::from_secs(5));if let Err(e)=cancel_session(&active,&lists,&routes,&mut output){failure=Some(e);output.clear();}continue},Err(e)=>{failure=Some(e);eof=true;output.clear();for(_,c)in active.values(){c.cancel();}continue}};
                let request:Value=match serde_json::from_slice(&bytes){Ok(v)=>v,Err(_)=>{queue(&mut output,rpc_error(Value::Null,-32700,"Parse error"))?;continue}};
                let id=request.get("id").cloned();let method=request.get("method").and_then(Value::as_str);let params=request.get("params").cloned().unwrap_or_else(||json!({}));
                if !request.is_object()||request["jsonrpc"]!="2.0"||method.is_none()||id.as_ref().is_some_and(|i|!valid_id(i))||!params.is_object(){queue(&mut output,rpc_error(Value::Null,-32600,"Invalid request"))?;continue}
                let method=method.expect("validated method");
                if id.is_none(){match method{
                    "notifications/initialized" if state==1=>state=2,
                    "notifications/cancelled"=>{if let Some(i)=params.get("requestId").filter(|i|valid_id(i)) {
                        let key=id_key(i);
                        if let Some((_,c))=active.get(&key){c.cancel();}
                        if let Some(index)=output.iter().position(|(_,_,k)|k.as_ref()==Some(&key)) {
                            if output[index].1==0 {
                                let mut replacement=VecDeque::new(); queue(&mut replacement,cancelled(i.clone(),lists.contains(&key),routes.get(&key)))?;
                                output[index]=replacement.pop_front().expect("cancel response"); output[index].2=Some(key);
                            } else {
                                failure=Some(io::Error::new(io::ErrorKind::BrokenPipe,"cancelled partial response"));eof=true;output.clear();for(_,c)in active.values(){c.cancel();}
                            }
                        }
                    }},
                    // Valid notifications never receive a JSON-RPC response,
                    // including unknown methods and repeated initialization.
                    _=>{}
                }continue}
                let id=id.expect("request id");let key=id_key(&id);
                if active.contains_key(&key){queue(&mut output,rpc_error(id,-32600,"Duplicate active request id"))?;continue}
                // Admission precedes routing: a session that could not start
                // answers every request but `ping` with its startup error.
                let advertised=match &admission{
                    Admission::Open(advertised)=>advertised,
                    Admission::Refused{code,message}=>{
                        let frame=if method=="ping"{result(id,json!({}))}else{json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":message,"data":{"code":code.as_str()}}})};
                        queue(&mut output,frame)?;continue
                    }
                };
                // A request naming its revision in `_meta` needs no session (stateless
                // 2026-07-28, as on HTTP); one without a claim needs initialize/discover.
                let enveloped=match request_envelope(&id,&params){Ok(enveloped)=>enveloped,Err(frame)=>{queue(&mut output,frame)?;continue}};
                let served=state==2||enveloped;
                let immediate=match method{
                    "initialize" if state==0=>{
                        // MCP negotiation: answer with the one revision this server speaks and
                        // let the client decide whether to continue (it disconnects if not).
                        let requested=params["protocolVersion"].as_str();
                        if requested.is_none_or(str::is_empty)||!params["clientInfo"]["name"].is_string()||!params["clientInfo"]["version"].is_string()||!params["capabilities"].is_object(){rpc_error(id,-32602,"Unsupported initialization")}else{if let Some(note)=requested.and_then(version_diagnostic){use std::io::Write as _;let _=writeln!(io::stderr(),"{note}");}state=1;result(id,advertised.with_instructions_field(json!({"protocolVersion":MCP_PROFILE,"capabilities":{"tools":{}},"serverInfo":{"name":"knowledge-base","version":env!("CARGO_PKG_VERSION")}})))}
                    }
                    "server/discover" if state==0||state==1||state==2=>{state=2;result(id,advertised.with_instructions_field(json!({"supportedVersions":[MCP_PROFILE],"capabilities":{"tools":{}},"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"knowledge-base","version":env!("CARGO_PKG_VERSION")}}})))}
                    "ping"=>result(id,json!({})),
                    "tools/list" if served=>{if params.get("cursor").is_some_and(|v|!v.is_null()){rpc_error(id,-32602,"Invalid params")}else if advertised.lists_live(){
                        // A live local list reads current authority off the event loop.
                        if active.len()>=MAX_IN_FLIGHT{rpc_error(id,-32000,"Too many in-flight requests")}else{
                            let control=CallControl::default();active.insert(key.clone(),(id.clone(),control));lists.insert(key.clone());let live=advertised.clone();
                            jobs.spawn_blocking(move||{let reply=match live.list_now(){Ok(tools)=>Ok(json!({"ttlMs":0,"cacheScope":"private","tools":tools})),Err(_)=>Err(rpc_error(id,-32603,"Tool list unavailable"))};(key,reply)});continue
                        }
                    }else{result(id,json!({"ttlMs":0,"cacheScope":"private","tools":advertised.tools()}))}}
                    "tools/call" if served=>{
                        let name=params.get("name").and_then(Value::as_str).and_then(|s|s.parse::<ToolName>().ok()).filter(|name|advertised.callable(*name));
                        if let Some(name)=name{
                            if active.len()>=MAX_IN_FLIGHT{rpc_error(id,-32000,"Too many in-flight requests")}else{
                                let mut args=params.get("arguments").cloned().unwrap_or_else(||json!({}));
                                // A multi-server call's `server` is checked and removed first.
                                let route=match advertised.take_route(name,&mut args){Ok(route)=>route,Err(None)=>{queue(&mut output,rpc_error(id,-32602,"Unknown tool"))?;continue},Err(Some(details))=>{queue(&mut output,result(id,tool_error(ErrorCode::InvalidArgument,details)))?;continue}};
                                let args=match name.check_input(args.clone()){Ok(args)=>args,Err(error)=>{queue(&mut output,result(id,labelled(tool_error(ErrorCode::InvalidArgument,crate::error::invalid_input_details_value(&error,&args)),route.as_deref())))?;continue}};
                                // A local scope decides before any handler runs.
                                if let Err(refusal)=advertised.admit(name,&args){queue(&mut output,result(id,labelled(refusal.tool_error(),route.as_deref())))?;continue}
                                let control=CallControl::default();active.insert(key.clone(),(id,control.clone()));if let Some(label)=&route{routes.insert(key.clone(),label.clone());}let h=handler.clone();let gate=advertised.stored_gate();
                                // Stored-metadata checks (staged upload kind) also precede the handler.
                                jobs.spawn_blocking(move||{let label=route.clone();let value=match gate.map_or(Ok(()),|(scope,source)|scope.admit_stored(source.as_ref(),name,&args)){Ok(())=>h(name,route,args,control),Err(refusal)=>refusal.tool_error()};(key,Ok(labelled(value,label.as_deref())))});continue
                            }
                        }else{rpc_error(id,-32602,"Unknown tool")}
                    }
                    "initialize"=>rpc_error(id,-32600,"Invalid session state"),
                    "tools/list"|"tools/call"=>rpc_error(id,-32600,"Invalid session state: send initialize or server/discover first, or name the protocol version in the request's _meta envelope"),
                    _=>rpc_error(id,-32601,"Unsupported method"),
                };queue(&mut output,immediate)?;
            }
            _=tokio::time::sleep(Duration::from_millis(10)),if eof||writing=>{
                if writing&&last_write.elapsed()>=Duration::from_secs(5){failure=Some(io::Error::new(io::ErrorKind::TimedOut,"stdio backpressure deadline"));eof=true;for(_,c)in active.values(){c.cancel();}output.clear();}
                if drain_until.is_some_and(|t|Instant::now()>=t){output.clear();failure.get_or_insert_with(||io::Error::new(io::ErrorKind::TimedOut,"stdio output drain timed out"));}
            }
        }
    }
    if let Some(e) = failure {
        Err(e)
    } else {
        tokio::time::timeout(Duration::from_secs(5), writer.flush())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "stdio flush timed out"))?
    }
}
// EOF and host shutdown cancel delivery as well as work. A frame already
// started cannot be replaced with another JSON object; close that stream.
fn cancel_session(
    active: &HashMap<String, (Value, CallControl)>,
    lists: &HashSet<String>,
    routes: &HashMap<String, String>,
    output: &mut VecDeque<(Vec<u8>, usize, Option<String>)>,
) -> io::Result<()> {
    for (_, control) in active.values() {
        control.cancel();
    }
    for entry in output.iter_mut() {
        let Some(key) = &entry.2 else { continue };
        let Some((id, _)) = active.get(key) else {
            continue;
        };
        if entry.1 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "cancelled partial response",
            ));
        }
        let mut replacement = VecDeque::new();
        queue(
            &mut replacement,
            cancelled(id.clone(), lists.contains(key), routes.get(key)),
        )?;
        entry.0 = replacement.pop_front().expect("cancel response").0;
    }
    Ok(())
}

/// The reply to a cancelled request: a `CANCELLED` tool result, or a
/// JSON-RPC error for a `tools/list`.
fn cancelled(id: Value, list: bool, route: Option<&String>) -> Value {
    if list {
        rpc_error(id, -32800, "Request cancelled")
    } else {
        result(
            id,
            labelled(
                tool_error(ErrorCode::Cancelled, json!({})),
                route.map(String::as_str),
            ),
        )
    }
}
/// A multi-server tool result names its server in `_meta` (beside the
/// untouched content), whoever produced it: the server, a local refusal, or
/// cancellation. One-server results (`route` is `None`) are unchanged.
fn labelled(mut value: Value, route: Option<&str>) -> Value {
    if let (Some(label), Some(object)) = (route, value.as_object_mut()) {
        let meta = object.entry("_meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        meta["kb/server"] = json!(label);
    }
    value
}

fn queue(output: &mut VecDeque<(Vec<u8>, usize, Option<String>)>, value: Value) -> io::Result<()> {
    queue_routed(output, value, None)
}
/// [`queue`] for a tool result: a multi-server call's oversized result is
/// replaced by a `QUOTA_EXCEEDED` result that still names its server
/// (`route`); a one-server replacement is unchanged.
fn queue_routed(
    output: &mut VecDeque<(Vec<u8>, usize, Option<String>)>,
    mut value: Value,
    route: Option<&str>,
) -> io::Result<()> {
    let mut bytes = Capped(Vec::new());
    if serde_json::to_writer(&mut bytes, &value).is_err() {
        let id = value["id"].clone();
        value = result(
            id,
            labelled(tool_error(ErrorCode::QuotaExceeded, json!({})), route),
        );
        bytes = Capped(Vec::new());
        serde_json::to_writer(&mut bytes, &value)?;
    }
    bytes.0.push(b'\n');
    output.push_back((bytes.0, 0, None));
    Ok(())
}

struct Capped(Vec<u8>);
impl io::Write for Capped {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > RESULT_MAX_BYTES {
            return Err(io::Error::other("stdio result exceeds 8 MiB"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oversized(route: Option<&str>) -> Value {
        let big = labelled(
            json!({"isError":false,"content":[{"type":"text","text":"x".repeat(RESULT_MAX_BYTES)}]}),
            route,
        );
        let mut output = VecDeque::new();
        queue_routed(&mut output, result(json!(7), big), route).expect("queued");
        let (bytes, _, _) = output.pop_front().expect("frame");
        serde_json::from_slice(&bytes).expect("json")
    }

    #[test]
    fn an_oversized_result_is_replaced_and_keeps_only_a_routed_label() {
        let routed = oversized(Some("work"));
        assert_eq!(
            routed["result"]["structuredContent"]["error"]["code"],
            "QUOTA_EXCEEDED"
        );
        assert_eq!(routed["result"]["_meta"], json!({"kb/server":"work"}));
        // One server: exactly the replacement it always was.
        let single = oversized(None);
        assert_eq!(
            single,
            result(json!(7), tool_error(ErrorCode::QuotaExceeded, json!({})))
        );
    }

    #[test]
    fn labelling_replaces_a_non_object_meta_and_keeps_other_keys() {
        assert_eq!(
            labelled(json!({"_meta":null}), Some("a"))["_meta"],
            json!({"kb/server":"a"})
        );
        assert_eq!(
            labelled(json!({"_meta":{"x":1}}), Some("a"))["_meta"],
            json!({"x":1,"kb/server":"a"})
        );
        assert_eq!(labelled(json!({"_meta":null}), None), json!({"_meta":null}));
    }
}
