const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const fs = require('fs');

if (cluster.isMaster) {
    console.log(`Master ${process.pid} is running`);

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`);
    });
} else {
    const app = express();
    ffmpeg.setFfmpegPath('./libs/ffmpeg/bin/ffmpeg.exe');
    ffmpeg.setFfprobePath('./libs/ffmpeg/bin/ffprobe.exe');
    const videoDir = path.join(__dirname, 'conteudos_stream');

    // Middleware
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, 'public')));
    app.set('view engine', 'ejs');

    // Configure session com FileStore
    app.use(session({
        store: new FileStore({
            path: path.join(__dirname, 'sessions'), // Diretório onde as sessões serão armazenadas
            secret: 'mySecretKey' // Secret adicional para encriptar os arquivos de sessão
        }),
        secret: 'mySecretKey',
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 3600000 } // Sessão expira em 1 hora
    }));

    // Middleware para verificar autenticação
    function checkAuth(req, res, next) {
        if (req.session.user) {
            next();
        } else {
            res.redirect('/');
        }
    }

    function getRandomIntervals(duration, videoWidth, videoHeight) {
        const intervals = [];
        const numberOfWatermarks = Math.max(0, Math.floor(duration / 10));
        const usedPositions = new Set();

        while (intervals.length < numberOfWatermarks) {
            const time = Math.floor(Math.random() * duration);
            const displayDuration = Math.floor(Math.random() * 5) + 5;
            const positionX = Math.floor(Math.random() * (videoWidth - 100));
            const positionY = Math.floor(Math.random() * (videoHeight - 50));
            const key = `${time}-${positionX}-${positionY}`;

            if (!usedPositions.has(key)) {
                intervals.push({ time, displayDuration, positionX, positionY });
                usedPositions.add(key);
            }
        }

        intervals.sort((a, b) => a.time - b.time);
        return intervals;
    }

    // Obter a lista de vídeos disponíveis
    function getAvailableVideos() {
        const files = fs.readdirSync(videoDir);
        return files.filter(file => path.extname(file) === '.mp4').map(file => {
            const id = path.basename(file, '.mp4');
            let title = `Vídeo ${id}`;
            let thumbnail = `/images/${id}.png`;

            // Personalize títulos e miniaturas com base no id
            if (id === '1') {
                title = 'Tom & Jerry';
                thumbnail = '/images/tomjerry.png';
            } else if (id === '2') {
                title = 'Chaves';
                thumbnail = '/images/chaves.png';
            }
            // Adicione mais condições conforme necessário

            return {
                id: id,
                title: title,
                thumbnail: thumbnail
            };
        });
    }

    app.get('/', (req, res) => {
        res.render('login', { error: null });
    });

    app.post('/login', (req, res) => {
        const email = req.body.email;
        if (!email) {
            return res.status(400).render('login', { error: 'Email é necessário.' });
        }

        // Simular autenticação do usuário
        req.session.user = { email };
        res.redirect('/content');
    });

    app.get('/content', checkAuth, (req, res) => {
        const email = req.session.user.email;
        const initial = email.charAt(0).toUpperCase();
        const videos = getAvailableVideos();

        res.render('content', {
            email: email,
            initial: initial,
            videos: videos
        });
    });

    // Nova rota para exibir a página de streaming
    app.get('/watch', checkAuth, (req, res) => {
        const user = req.session.user;
        const videoId = req.query.id;

        if (!videoId) {
            return res.status(400).send('ID do vídeo é necessário.');
        }

        const video = getAvailableVideos().find(v => v.id === videoId);

        if (!video) {
            return res.status(404).send('Vídeo não encontrado.');
        }

        res.render('stream', {
            email: user.email,
            initial: user.email.charAt(0).toUpperCase(),
            videoId: videoId,
            videoTitle: video.title
        });
    });

    // Rota para transmitir o vídeo com as marcas d'água
    app.get('/video', checkAuth, (req, res) => {
        const user = req.session.user;
        const videoId = req.query.id;

        if (!videoId) {
            return res.status(400).send('ID do vídeo é necessário.');
        }

        const videoFilePath = path.join(videoDir, `${videoId}.mp4`);

        if (!fs.existsSync(videoFilePath)) {
            return res.status(404).send('Vídeo não encontrado.');
        }

        ffmpeg.ffprobe(videoFilePath, (err, metadata) => {
            if (err) {
                console.error('Erro ao analisar o vídeo:', err);
                return res.status(500).send('Erro ao analisar o vídeo');
            }

            const duration = metadata.format.duration;
            const videoWidth = metadata.streams[0].width;
            const videoHeight = metadata.streams[0].height;
            const intervals = getRandomIntervals(duration, videoWidth, videoHeight);

            let filterComplex = intervals.map(({ time, displayDuration, positionX, positionY }, index) => {
                return `drawtext=fontfile=./fonts/arial/ARIAL.ttf:text='${user.email}':x=${positionX}:y=${positionY}:fontsize=20:fontcolor=white@0.1:enable='between(t,${time},${time + displayDuration})'`;
            }).join(',');

            let responseSent = false;
            let command = ffmpeg(videoFilePath)
                .format('mp4')
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions('-movflags frag_keyframe+empty_moov')
                .complexFilter(filterComplex)
                .on('start', () => {
                    console.log(`Iniciando a transmissão com marcas d'água para ${user.email}...`);
                })
                .on('error', (err) => {
                    console.error('Erro no FFmpeg:', err);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(500).send('Erro no processamento do vídeo.');
                    }
                    command.kill('SIGKILL');
                })
                .on('end', () => {
                    console.log('Transmissão finalizada.');
                    if (!responseSent) {
                        responseSent = true;
                        res.end();
                    }
                });

            res.setHeader('Content-Type', 'video/mp4');
            req.on('close', () => {
                console.log('Conexão com o cliente fechada prematuramente.');
                if (!responseSent) {
                    responseSent = true;
                    command.kill('SIGKILL');
                }
            });

            command.pipe(res, { end: true });
        });
    });

    app.get('/logout', (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                return res.status(500).send('Erro ao encerrar a sessão.');
            }
            res.redirect('/');
        });
    });

    const PORT = 3000;
    app.listen(PORT, () => {
        console.log(`Worker ${process.pid} started, servidor rodando em http://localhost:${PORT}`);
    });
}
