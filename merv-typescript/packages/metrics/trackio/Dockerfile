FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# A new named volume takes this directory's owner, so Trackio writes it without root.
RUN useradd --uid 10001 --no-create-home trackio && mkdir -p /data/trackio && chown trackio /data/trackio
COPY serve.py .
USER trackio
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
CMD ["python", "serve.py"]
