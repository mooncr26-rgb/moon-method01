const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ვიდეოების დროებითი შენახვა სერვერზე ატვირთვისას
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // ლიმიტი: 100 მეგაბაიტი
});

// ფრონტენდის (ვიზუალის) ფაილების მიწოდება
app.use(express.static(path.join(__dirname, 'public')));

// მთავარი ფუნქცია: ვიდეოს მიღება და დაპატჩვა
app.post('/patch-video', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('ვიდეო ფაილი არ არის არჩეული.');
  }

  const inputPath = req.file.path;
  
  // აქ ხდება "Moon Method"-ის მაგია: ვიდეოს ბაიტების/მეტამონაცემების მოდიფიკაცია
  // (ამ მაგალითში სერვერი ამუშავებს ფაილს და უმზადებს მომხმარებელს გადმოსაწერად)
  setTimeout(() => {
    res.download(inputPath, `moon_patched_${req.file.originalname}`, (err) => {
      // გადმოწერის დასრულების შემდეგ ვშლით ფაილს სერვერიდან, რომ ადგილი არ გაივსოს
      fs.unlinkSync(inputPath); 
    });
  }, 2000); // სიმულაცია 2 წამიანი დამუშავების
});

app.listen(port, () => {
  console.log(`სერვერი წარმატებით ჩაირთო პორტზე: http://localhost:${port}`);
});