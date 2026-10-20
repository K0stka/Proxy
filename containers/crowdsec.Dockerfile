FROM crowdsecurity/crowdsec:latest
ARG PROXY_SECURITY_REFRESH
RUN apk add --no-cache python3 && mkdir -p /security-ipc && chown 0:10000 /security-ipc && chmod 2770 /security-ipc
COPY containers/crowdsec-agent.py /usr/local/bin/proxy-crowdsec.py
ENTRYPOINT ["python3", "/usr/local/bin/proxy-crowdsec.py"]
