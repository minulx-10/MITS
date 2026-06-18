#!/bin/bash
# 1번 서버를 위한 가상 방을 만들고, 그 방에 직접 명령어를 타이핑해서 실행합니다.
tmux new-session -d -s mc1
tmux send-keys -t mc1 "cd ~/server1 && java -Xms3G -Xmx3G -jar paper.jar nogui" ENTER

# 2번 서버를 위한 가상 방을 만들고, 똑같이 실행합니다.
tmux new-session -d -s mc2
tmux send-keys -t mc2 "cd ~/server2 && java -Xms3G -Xmx3G -jar paper.jar nogui" ENTER

echo "두 서버에 실행 명령을 완전히 보냈습니다!"
