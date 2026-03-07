
async function load(){

const res = await fetch("/admin/groups")
const data = await res.json()

const keyword = document.getElementById("search").value

const table = document.getElementById("table")
table.innerHTML=""

data.groups
.filter(g=>g.groupId.includes(keyword))
.forEach(g=>{

const tr=document.createElement("tr")

tr.innerHTML=`
<td>${g.groupId}</td>
<td><input id="l_${g.groupId}" value="${g.language||""}"></td>
<td><input id="i_${g.groupId}" value="${g.industry||""}"></td>
<td><input id="v_${g.groupId}" value="${g.inviter||""}"></td>
<td><button onclick="save('${g.groupId}')">save</button></td>
`

table.appendChild(tr)

})

}

async function save(groupId){

const language=document.getElementById("l_"+groupId).value
const industry=document.getElementById("i_"+groupId).value
const inviter=document.getElementById("v_"+groupId).value

const res=await fetch("/admin/group/update",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({groupId,language,industry,inviter})
})

const data=await res.json()

if(data.success){
alert("updated")
}else{
alert("error")
}

}

load()
