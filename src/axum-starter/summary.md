# axum-starter 开发日志

`axum-starter` 是作者开发完成的辅助启动axum Service 的工具库

[![Crates.io](https://img.shields.io/crates/v/axum-starter.svg?style=for-the-badge)](https://crates.io/crates/axum-starter)
[![Github](https://img.shields.io/badge/github-8da0cb?style=for-the-badge&labelColor=555555&logo=github)](https://github.com/Goodjooy/axum-server-starter)

## 为什么要 `axum-starter`

随着服务程序的功能需求越来越多，在程序启动时需要进行的各种连接其他服务，初始化程序等准备工作的过程会变得越来约复杂。因此，我便希望能够提供一套统一的接口，以能够用直观清晰的代码体现服务启动时各个功能模块的启动顺序并启动服务

## 特点

### forbid unsafe

此crate 启用了 `#![forbid(unsafe)]` 不会使用任何unsafe 代码，保证安全性

