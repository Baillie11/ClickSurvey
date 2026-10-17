const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const nodemailer = require("nodemailer");
test("real Nodemailer SMTP handshake submits one complete message locally", async () => {
  let message = "",
    received = 0;
  const server = net.createServer((socket) => {
    socket.write("220 localhost test SMTP\r\n");
    let pending = "",
      data = false;
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 2);
        if (data) {
          if (line === ".") {
            data = false;
            received++;
            socket.write("250 queued\r\n");
          } else message += line + "\n";
        } else if (/^EHLO|^HELO/.test(line)) socket.write("250 localhost\r\n");
        else if (/^MAIL FROM:|^RCPT TO:/.test(line)) socket.write("250 OK\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 End with dot\r\n");
        } else if (line === "QUIT") {
          socket.end("221 goodbye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: server.address().port,
    secure: false,
    ignoreTLS: true,
  });
  try {
    const result = await transport.sendMail({
      from: "test@example.com",
      to: "recipient@example.com",
      subject: "ClickSurvey test",
      text: "Survey invitation",
    });
    assert.equal(result.accepted[0], "recipient@example.com");
    assert.equal(received, 1);
    assert.ok(message.includes("Survey invitation"));
  } finally {
    transport.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
