# TERRAWATCH

TERRAWATCH 是一套全屏、双语的地球观测交互界面，包含全彩卫星图、实时云层、全球降水、地表温度、模拟风场与地球事件。下载包同时提供可直接上传的纯静态版本和完整源码。

## 推荐：直接部署纯静态版本

`static-site/` 内是已经构建完成的网站，不需要 Node.js、数据库、环境变量或 API Key。

1. 将 `static-site/` 里面的全部文件上传到服务器网站根目录，例如：
   - Nginx：`/var/www/terrawatch`
   - cPanel：`public_html`
   - Apache：站点的 `DocumentRoot`
2. 注意上传的是 `static-site` 里面的内容，不要在网站根目录外面再多套一层文件夹。
3. 启用 HTTPS，然后打开域名检查六个频道。

也可以使用 `source/deploy/nginx-static.conf` 作为 Nginx 配置示例。把其中的域名换成你自己的域名即可。

## Docker 部署

进入 `source/` 目录后运行：

```bash
docker compose up -d --build
```

访问：

```text
http://服务器IP:8080
```

停止或更新：

```bash
docker compose down
docker compose up -d --build
```

## Node.js 服务器备用方式

`source/` 还包含已经构建好的 `dist/` 和一个普通 Node.js 入口。需要 Node.js 22 或更高版本：

```bash
cd source
HOST=0.0.0.0 PORT=8080 node server.mjs
```

如果需要长期运行，可以参考 `source/deploy/terrawatch.service` 与 `source/deploy/nginx-node-proxy.conf`。

## 修改源码后重新构建

源码位于 `source/app/`。在 Linux 环境中运行：

```bash
cd source
npm ci
npm run build:static
```

新的纯静态版本会生成到 `source/out/`。如果需要重新生成 Node.js 版本：

```bash
npm run build
```

构建要求：

- Node.js `>=22.13.0`
- Linux
- `flock`、`curl` 和 GNU `timeout`（Node.js 版本的构建脚本需要）

## 数据连接

TERRAWATCH 的数据由访问者浏览器直接读取，不经过你的服务器。访问者网络需要能够连接以下公开数据源：

- NASA GIBS：卫星、云层、降水和地表温度
- USGS：地震事件
- NASA EONET：其他自然事件
- CARTO / OpenStreetMap：暗色地名标注

如果网站可以打开但个别图层空白，通常是访问者所在网络无法连接相应公开数据源。

## 说明

- 纯静态、只读展示，不保存用户数据
- 不包含密码、令牌或服务器端密钥
- 默认部署在域名根目录，例如 `https://earth.example.com/`
- 如需部署到子目录，例如 `https://example.com/terrawatch/`，需要按该路径重新构建
- 模拟风场明确标注为视觉模拟，不代表实测风速
- 地图标注版权：© OpenStreetMap contributors，© CARTO
