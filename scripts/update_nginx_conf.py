import sys

conf_path = "/etc/nginx/conf.d/winkey.conf"
with open(conf_path, "r") as f:
    content = f.read()

target = "add_header X-Content-Type-Options nosniff always;"
replacement = 'add_header X-Content-Type-Options nosniff always;\n        add_header Cache-Control "public, max-age=31536000, immutable" always;'

duplicate = '\n        add_header Cache-Control "public, max-age=31536000, immutable" always;'
if duplicate in content:
    content = content.replace(duplicate, "")
    with open(conf_path, "w") as f:
        f.write(content)
    print("Reverted duplicate add_header successfully")

