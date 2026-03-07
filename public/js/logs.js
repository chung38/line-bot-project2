
async function load(){

const res = await fetch("/admin/logs")
const data = await res.json()

const tbody=document.getElementById("logs")
tbody.innerHTML=""

data.logs.forEach(l=>{

const tr=document.createElement("tr")

tr.innerHTML=`
<td>${l.time}</td>
<td>${l.event}</td>
<td>${l.groupId||""}</td>
`

tbody.appendChild(tr)

})

}

load()
