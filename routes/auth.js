const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");

const router = express.Router();
const SECRET = "PIA_SECRET_KEY";

router.post("/login", (req, res) => {
  const { username, password } = req.body;

  const users = JSON.parse(fs.readFileSync("users.json"));
  const user = users.find(u => u.username === username);

  if (!user) {
    return res.status(401).json({ message: "Kullanıcı bulunamadı" });
  }

  const isMatch = bcrypt.compareSync(password, user.password);

  if (!isMatch) {
    return res.status(401).json({ message: "Şifre yanlış" });
  }

  const token = jwt.sign(
    { id: user.id, role: user.role },
    SECRET,
    { expiresIn: "1h" }
  );

  res.json({ token, role: user.role });
});

module.exports = router;
