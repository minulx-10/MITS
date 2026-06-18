#!/bin/bash
tmux send-keys -t mc1 "stop" ENTER
tmux send-keys -t mc2 "stop" ENTER
echo "두 서버에 종료 명령을 보냈습니다. 안전하게 저장 후 꺼집니다."
