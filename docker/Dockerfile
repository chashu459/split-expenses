FROM nginx:alpine

# Static frontend (~48KB). No build step, no runtime dependencies.
COPY frontend/ /usr/share/nginx/html/

# Injects $API_URL into config.js at container start, so you can change the
# backend URL without rebuilding the image.
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
