const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { Configuration, OpenAIApi } = require("openai");
const bodyParser = require('body-parser');
const { XMLParser} = require("fast-xml-parser");
const fs = require('fs');
const app = express();
const port = 3005;
const moment = require('moment');
require('dotenv').config();
const splitIntoSentences = require('sentence-splitter');

fs.readFile('update.txt', 'utf8', (err, data) => {
  if (err) throw err;
  global.updated = data;
  console.log(global.updated);
}); ;

app.get('/', (req, res) => {
  const content = req.query.content;
  const data = {msg: `Hello, This is test API! ${content}`};
  console.log(req.body);
  res.status(200).send(data);
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// 通过axios获取RSS地址
async function getRssUrl() {
  const rssUrl = `${process.env.RSS_URL_JP}`;
  try {
    const response = await axios.get(rssUrl);
    const parser = new XMLParser();
    const jsonData = parser.parse(response.data);//获取到了所有的rss的entry，返回string[]
    const items = jsonData.rss.channel.item[0]; //获取第一个items
    const updated = items.pubDate;
    if (updated != global.updated) {
      fs.writeFile('update.txt', updated, err => {
        if (err) throw err;
        console.log('news update');
      });
      global.updated = updated;
      return items;
    }
  } catch (error) {
    console.error(error);
    return null;
  }
}


// 通过axios获取HTML内容并使用cheerio解析
async function scrapeData(items){
  const response = await axios.get(items.link);
  const $ = cheerio.load(response.data);
  const link = `  [原文地址](${items.link})`;
  const html = $("article.arti-body.cf.cXenseParse.editor-revolution").clone();
  html.find('.af_box').remove();
  html.find('script').remove();
  const body = html.html();
  const writer = $("span.writer.writer-name").html();
  const cover = $('meta[name="twitter:image"]').attr('content');
  const head = cover+JSON.stringify(items)+writer;
  //console.log(head);
  //console.log(body);
  const tphead = await steamgpt_head(head);
  const mdbody = await splitSentences(body);

  if (tphead != null) {
    const full = tphead + '\n' + mdbody + '\n' + '\n'+ link;
    return full;
  }
  else{
    return null;
  }
}

//上传文件到github上
async function pushmd(markdowndata,filename){
  // 上传的文件内容
  const fileContent = markdowndata;

  // 仓库拥有者、仓库名和分支名
  const owner = 'Tokoy';
  const repo = 'animenews';
  const branch = 'main';

  // 文件路径和文件名，注意要使用斜杠分隔路径
  const fileName = filename;
  const filePath = `src/pages/posts/${fileName}`;

  // GitHub API 路径
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

  // 构造 HTTP 请求头，包含授权信息和 Accept 头部
  const headers = {
    Authorization: `token ${process.env.GITHUB_ACCESS_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
  };

  // 构造提交数据，包含文件名、文件内容和分支名
  const data = {
    message: `Add file ${fileName}`,
    content: Buffer.from(fileContent).toString('base64'),
    branch: branch,
  };
  // 发送 PUT 请求，创建或更新文件
  axios.put(apiUrl, data, { headers })
  .then(response => {
    console.log(`File ${fileName} uploaded to GitHub.`);
  })
  .catch(error => {
    console.error(`Failed to upload file ${fileName} to GitHub:`, error);
  });
}

async function splitSentences(text){
  // 拆分为句子
  const sentences = splitIntoSentences.split(text) 

  const segmentSize = 10; // 每段包含的句子数量
  let segments = [];
  let currentSegment = [];
  for (let i = 0, len = sentences.length; i < len; i++) {
    currentSegment.push(sentences[i]);
    if (currentSegment.length === segmentSize) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  }

  let article = "";
  // 输出拆分结果
  for (let [index, segment] of segments.entries()) {
    const text = segment.map((sentence) => sentence.raw).join(' ');
    //console.log(`第 ${index + 1} 段：${text}`);
    let msg = await steamgpt_body(text);
    article = article + "\n" + msg;
    await setTimeout(() => {}, 1000);
    //console.log(article);
  }

  return article
}


async function steamgpt_head(content) {
  const configuration = new Configuration({
    apiKey: `${process.env.FREE_API_KEY}`,
    basePath: `${process.env.FREE_API_BASE}`
  });
  // OpenAI instance creation
  const openai = new OpenAIApi(configuration);

  const template = `---
  layout: '../../layouts/MarkdownPost.astro'
  title: "替换为中文标题"  
  pubDate: 日期为YYYY-MM-DDThh:mm:ssZ
  description: "替换为中文描述"
  author: "替换为作者名称"
  cover:
    url: '替换为https://animeanime.jp/imgs/ogp_f/的图片'
    square: '替换为https://animeanime.jp/imgs/ogp_f/的图片'
    alt: "cover"
  tags: ["news","anime","替换为文章标签"]
  theme: 'light'
  featured: false
  ---
  ![cover](替换为https://animeanime.jp/imgs/ogp_f/的图片)
  `;
  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {"role": "system", "content": `转换为中文，保持模板格式: ${template}`},
        {"role": "user", "content": `${content}`},
      ],
      temperature: 0,
      stream: true,
  }, { responseType: 'stream' });
  const stream = completion.data;
  return new Promise((resolve, reject) => {
    const payloads = [];
    let sentence = ''; // 用于存储组成的句子
    stream.on('data', (chunk) => {
      const data = chunk.toString();
      payloads.push(data);
    });

    stream.on('end', () => {
      const data = payloads.join(''); // 将数组中的数据拼接起来
      const chunks = data.split('\n\n');
      for (const chunk of chunks) {
        if (chunk.includes('[DONE]')) return;
        if (chunk.startsWith('data:')) {
          const payload = JSON.parse(chunk.replace('data: ', ''));
          try {
            const chunk = payload.choices[0].delta?.content;
            if (chunk) {
              sentence += chunk; // 将单词添加到句子中
            }

          } catch (error) {
            console.log(`Error with JSON.parse and ${chunk}.\n${error}`);
            reject(error);
          }
        }
      }
    });
    stream.on('error', (err) => {
        console.log(err);
    });
    stream.on('close', () => {
      resolve(sentence);
  });
  })
  } catch (err) {
    console.log(err);
  }
}

async function steamgpt_body(body){
  const configuration = new Configuration({
    apiKey: `${process.env.FREE_API_KEY}`,
    basePath: `${process.env.FREE_API_BASE}`
  });
  // OpenAI instance creation
  const openai = new OpenAIApi(configuration);
  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {"role": "system", "content": `你现在是一个日本动漫资讯网站的编辑，你将会收到一些分割后的html格式的日文的文本数据,这些文本都和日本动漫相关,我需要你执行下面的步骤对文本进行处理: 1.把html转换成markdown格式,需要保留imgs图片地址。2.将文本翻译成中文,人名和作品名称不需要翻译。3.优化文本的排版,让文章看起来更美观。`},
        {"role": "user", "content": `${body}`},
      ],
      temperature: 0,
      stream: true,
    }, { responseType: 'stream' });
  
    const stream = completion.data;
    return new Promise((resolve, reject) => {
      const payloads = [];
      let sentence = ''; // 用于存储组成的句子
      stream.on('data', (chunk) => {
        const data = chunk.toString();
        payloads.push(data);
      });

      stream.on('end', () => {
        const data = payloads.join(''); // 将数组中的数据拼接起来
        const chunks = data.split('\n\n');
        for (const chunk of chunks) {
          if (chunk.includes('[DONE]')) return;
          if (chunk.startsWith('data:')) {
            const payload = JSON.parse(chunk.replace('data: ', ''));
            try {
              const chunk = payload.choices[0].delta?.content;
              if (chunk) {
                sentence += chunk; // 将单词添加到句子中
              }

            } catch (error) {
              console.log(`Error with JSON.parse and ${chunk}.\n${error}`);
              reject(error);
            }
          }
        }
      });
      stream.on('error', (err) => {
          console.log(err);
      });
      stream.on('close', () => {
        resolve(sentence);
    });
  })
  } catch (error) {
    if (error.response) {
      console.error(error.message);
      return '';
    }
  }
}

//定时任务
const intervalId = setInterval(() => {
  //console.info("开始抓取");
  getRssUrl().then(url => {
    if(url != undefined){
      //console.info(url);
      //获取文章内容
      scrapeData(url).then(ch =>{
        //ai转换为markdown格式
          if(ch != null || ch != undefined){
            const timestamp = moment().format('YYYYMMDDHHmm');
            //fs.writeFileSync(`md/${timestamp}.md`, ch); //生成md文件
            pushmd(ch,`${timestamp}.md`); //push到github
          }
      });
    }
  });
}, 600000); 

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});