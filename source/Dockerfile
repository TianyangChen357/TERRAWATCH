FROM nginx:1.27-alpine

COPY out /usr/share/nginx/html
COPY deploy/nginx-container.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
