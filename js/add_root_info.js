const link = document.createElement('a')
link.href = "https://beian.miit.gov.cn/"
link.target = "_block"
link.style = "color:#FFF"
link.innerHTML = "闽ICP备2022002309号-1"

let div = document.getElementsByClassName("sidebar-scrollbox")[0]
div.appendChild(link)
console.log(link)
console.log("added link");