
async function load(){

const res = await fetch("/admin/dashboard")
const data = await res.json()

document.getElementById("total").innerText = data.total
document.getElementById("today").innerText = data.today

document.getElementById("langs").innerText =
JSON.stringify(data.languages,null,2)

document.getElementById("inds").innerText =
JSON.stringify(data.industries,null,2)

}

load()
