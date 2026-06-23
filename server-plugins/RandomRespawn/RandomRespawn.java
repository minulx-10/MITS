package site.mits.randomrespawn;

import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.WorldBorder;
import org.bukkit.block.Block;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.concurrent.ThreadLocalRandom;

/**
 * 침대/리스폰앵커가 있으면 그대로 존중하고,
 * 없을 때만(= 죽을 때마다) 월드보더 안쪽 안전한 랜덤 위치로 새로 리스폰시킨다.
 * 오버월드에서만 동작. 의존성 없음(서버 paper.jar API만 사용).
 */
public class RandomRespawn extends JavaPlugin implements Listener {

    private int margin;
    private int attempts;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        margin = getConfig().getInt("border-margin", 100);
        attempts = getConfig().getInt("safe-attempts", 24);
        getServer().getPluginManager().registerEvents(this, this);
        getLogger().info("RandomRespawn 활성화 (margin=" + margin + ", attempts=" + attempts + ")");
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = false)
    public void onRespawn(PlayerRespawnEvent e) {
        // 침대/앵커 스폰은 존중 — 손대지 않음
        if (e.isBedSpawn() || e.isAnchorSpawn()) return;

        Location cur = e.getRespawnLocation();
        World world = (cur != null) ? cur.getWorld() : e.getPlayer().getWorld();
        // 오버월드에서만 랜덤 리스폰(네더/엔드의 천장 등 오탐 방지)
        if (world == null || world.getEnvironment() != World.Environment.NORMAL) return;

        Location safe = randomSafe(world);
        if (safe != null) e.setRespawnLocation(safe);
    }

    /** 월드보더 안쪽에서 안전한 지상 좌표를 매번 새로 뽑는다. 못 찾으면 null. */
    private Location randomSafe(World world) {
        WorldBorder wb = world.getWorldBorder();
        Location c = wb.getCenter();
        double half = Math.max(16.0, (wb.getSize() / 2.0) - margin);
        ThreadLocalRandom rnd = ThreadLocalRandom.current();

        for (int i = 0; i < attempts; i++) {
            int x = (int) Math.floor(c.getX() + (rnd.nextDouble() * 2 - 1) * half);
            int z = (int) Math.floor(c.getZ() + (rnd.nextDouble() * 2 - 1) * half);
            int y = world.getHighestBlockYAt(x, z);
            if (y <= world.getMinHeight() + 1) continue; // 바닥 없음/공허

            Block ground = world.getBlockAt(x, y, z);
            Material m = ground.getType();
            if (!isSafeGround(m)) continue;

            return new Location(world, x + 0.5, y + 1, z + 0.5, rnd.nextFloat() * 360f - 180f, 0f);
        }
        return null;
    }

    private boolean isSafeGround(Material m) {
        if (!m.isSolid()) return false;
        switch (m) {
            case WATER:
            case LAVA:
            case MAGMA_BLOCK:
            case CACTUS:
            case FIRE:
            case POWDER_SNOW:
            case CAMPFIRE:
            case SOUL_CAMPFIRE:
                return false;
            default:
                return !m.name().contains("LEAVES");
        }
    }
}
