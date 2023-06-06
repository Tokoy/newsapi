def handler(request, response):
    response.status_code = 200
    response.headers.set("Content-Type", "text/plain")
    response.send("Hello, world!")