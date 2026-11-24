#event_simpleName=ProcessRollup2 event_platform=Win AND ImageFileName=/\\cmd\.exe$/i

head(10) | groupBy(status_code, function=count) | timeChart(method, span=5min)

in(severity, values=["critical", "high"]) | selfJoin(email_id, where=[{from=*peter*}, {to=*anders*}], collect=[from,to]) | rename(field=[[a, b], [c, d]])

foo := a + b | bar := a / b | a:=m/fisk/i
| upperhost := upper(host) | "Success":=1 | #type := "fortigate"

correlate(LoginFail1 : { logon = FAILURE }, LoginSuccess : { logon = SUCCESS | user.email <=> LoginFail1.user.id } include: [user.email, platform], sequence=true, within=15m)

errortime := if((@ingesttimestamp > @timestamp), then=@timestamp, else=@ingesttimestamp) / 1000
| test(length(userid) == length(method))
| pct := (part * 100) % total

/* Search for killed processes */ ?{signal="*"} | /Service exited due to (?<signal>\S+)/ | signal = ?signal

case { HookId = "0" | HookId := "WH_JOURNALRECORD" ; !cidr(ip, subnet="10.0.0.0/8") | scope := "public" ; * }

| case {
    src="client-side" | type := "client";
    src="frontend-server" | ip != 192.168.1.1 | type := "frontend";
    // catch-all
    * | type := "server";
}
| case { event_platform=Lin | Status:="OK"; * ; }

correlate(Login: { #action="login" }, Purchase: { #action="purchase" | userId <=> Login.userId }, aggregation = [ pageViews: { #action="pageView" | userId <=> Login.userId | count() } after: "Login" before: "Purchase" ])

url = *login* user != * name = "" "host-name"=* host[0]=* #repo=base_sensor
| class like "foo*bar" statuscode >= 400 Severity >= "80" LocalPort < ?maxPort
| method != /(PUT|POST)/ repo.name=docker/* foo=m/fisk/i

@timestamp=* ioc[0].indicator.country=US my.Field..name=x 400 = statuscode
| user.email := lower(Vendor.properties.userPrincipalName)

ip_addr =~ cidr(subnet="127.0.0.1/24")
| loglevel =~ !in(values=["ERROR", "WARN"])
| aid =~ join({#event_simpleName=AgentOnline}, field=aid, include=[ComputerName])

foo "Lorem ipsum" /Service exited due to (?<signal>\S+)/ * https://www.example.com/ ?{signal="*"}

groupby([ioc[0].indicator, source.ip], function=[selectlast(@timestamp), count()], limit=max)
| array:contains(array="`filters.not-values`[]", value="9847598475")
| sort(hostname, order=asc)

#host=github #parser=json | // c
repo.name=docker/* // trailing
| https: //www.example.com/

correlate(Login: { #action="login" }, Purchase: { #action="purchase" | userId <=> Login.userId }, sequence=true, within=15m)

UserIsAdmin match { 1 => UserIsAdmin := "True" ; 0 => UserIsAdmin := "False" ; * => * }

logtype match {
  "accesslog" => time:=response_time ;
  /server_\d+/ => time:=server_time*1000 ;
  in(values=[5, 56, 567]) => kind := "listed";
  ** => * ;
}

wildcard(field=animal, pattern=*h*rse*, ignoreCase=true)
| eval(a = b, x = y + z)
| format("%s:%s", field=[aid, cid], as="key")

correlate(query=Q1: { #type=a }, Q2: { #type=b | x <=> Q1.x })

!in(loglevel, values=["DEBUG", "INFO"])
| not test(cputime < 7500)
| !cidr(RemoteAddressIP4, subnet=["10.0.0.0/8", "192.168.0.0/16"])

foo not statuscode=200
| NOT ParentBaseFileName=explorer.exe !UserName=/\$$/

statuscode=404 and (method=GET or method=POST)
| foo or not bar and baz

x := (a + b) * 2

#event_simpleName=ProcessRollup2 (ImageFileName=/\\net1?\.exe/i CommandLine=/view/i) OR (ImageFileName=/\\nltest\.exe/i)

#event_simpleName=ProcessRollup2 event_platform=Win
| ImageFileName=/\\powershell\.exe$/i
| groupBy([aid, ComputerName], function=count(as=executions))
| sort(executions, order=desc, limit=20)

host = ?host
| matchstring := ?"Matching String to Locate"
| groupBy(field=?{basefield="@host"})
| ComputerName=?{ComputerName=*}

ImageFileName=/\\cmd\.exe$/iF CommandLine=/[-/][ix]\s*(?<URL>https?:\S+)/i
| /fisk/i

$"My Saved Query"() | $filterOutFalsePositive()
| $falcon/helper:enrich(field=LogonType)
| $query://anotherView:saved()

$tausight/ephi-risk-posture:Tausight_ePHIStored(HostName=?{HostName=*})
| $mySavedQuery(mvArgument=["value1", "value2"], path=C:\Windows\*)

[min(x), max(x)]
| [min_response := min(responsetime), max_response := max(responsetime)]

"msg:\"welcome\" " | user= "Alan Turing" | regex("\x5c\x5c(?<file_name>[^\\]+)$", field=TargetFileName)

defineTable(query={ | value=42 }, include=*, name="")
| join(query={#repo=B session_id=*}, field=session_id, key=session_id)
| groupBy(type, function={ avgFoo := avg(foo) | outFoo := round(avgFoo) })

delta := -x + 1 | test(!isEmpty)

